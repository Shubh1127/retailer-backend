/**
 * Musgrave category persistence.
 *
 * The only place that talks to Supabase about categories. Fetching and parsing
 * live elsewhere; this layer takes an already-flattened payload and applies it.
 *
 * Writes go through the `musgrave_sync_category_tree` RPC rather than a series of
 * table calls. That is deliberate: supabase-js has no cross-statement
 * transaction, so N separate upserts could leave the tree half-applied if one
 * failed. A plpgsql function is a single transaction — the tree either advances
 * completely or not at all — and it makes the whole apply idempotent.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { createLogger } from '../log.js';
import type { FlatCategoryNode } from '../services/musgraveCategories.parse.js';

const log = createLogger('musgrave:categories:repo');

/** Payload size past which the single-transaction apply is worth a warning. */
const LARGE_PAYLOAD_BYTES = 6 * 1024 * 1024;

export interface CategorySyncSummary {
  syncRunId: number;
  categoriesSeen: number;
  attributesSeen: number;
  pathsSeen: number;
  categoriesDeactivated: number;
}

export interface CategorySyncContext {
  /** The dynamic spgid the tree was fetched under. Recorded, never hardcoded. */
  spgid: string;
  sourceUrl: string;
}

/** A category row as stored, in the shape downstream syncs need. */
export interface StoredCategory {
  id: number;
  categoryRef: string;
  musgraveId: string;
  name: string;
  depth: number;
  sortPath: string | null;
  /**
   * The API's own category path — every ancestor id, root first, ending with this
   * category. Product URLs need the FULL path, not the leaf id:
   * `/categories;spgid=X/RetailWebHierarchy/WebCat_405879/products`.
   * Sourced from musgrave_category_paths, which stores it in order.
   */
  pathSegments: string[];
}

/** PostgREST caps a response at 1000 rows; reads page through in these chunks. */
const READ_PAGE_SIZE = 1000;

export interface MusgraveCategoryRepository {
  /** Apply the whole tree atomically. Returns what changed. */
  saveCategoryTree(
    nodes: readonly FlatCategoryNode[],
    context: CategorySyncContext,
  ): Promise<CategorySyncSummary>;

  /** Record a failed attempt — the RPC's own run row rolls back with it. */
  recordFailedRun(context: CategorySyncContext, message: string): Promise<void>;

  /** Rebuild the nested document as the API returned it. */
  loadCategoryTree(includeInactive?: boolean): Promise<unknown>;

  /** Every stored category, in tree order. Used to drive the product sync. */
  listCategories(options?: { includeInactive?: boolean }): Promise<StoredCategory[]>;
}

/** Shape returned by musgrave_sync_category_tree(). */
interface SyncRpcResult {
  syncRunId: number;
  categoriesSeen: number;
  attributesSeen: number;
  pathsSeen: number;
  categoriesDeactivated: number;
}

export class SupabaseMusgraveCategoryRepository implements MusgraveCategoryRepository {
  async saveCategoryTree(
    nodes: readonly FlatCategoryNode[],
    context: CategorySyncContext,
  ): Promise<CategorySyncSummary> {
    const supabase = getSupabaseClient();
    const payload = nodes as unknown as Record<string, unknown>[];

    const bytes = JSON.stringify(payload).length;
    if (bytes > LARGE_PAYLOAD_BYTES) {
      // Splitting would buy smaller requests at the cost of atomicity, so the
      // size is surfaced rather than silently traded away.
      log.warn('Large category payload sent in a single transaction', {
        bytes,
        nodes: nodes.length,
      });
    }

    log.info('Applying category tree', { nodes: nodes.length, bytes });

    const { data, error } = await supabase.rpc('musgrave_sync_category_tree', {
      p_nodes: payload,
      p_spgid: context.spgid,
      p_source_url: context.sourceUrl,
    });

    if (error) {
      throw new Error(
        `musgrave_sync_category_tree failed: ${error.message}` +
          (error.hint ? ` (hint: ${error.hint})` : ''),
      );
    }

    const result = (data ?? {}) as Partial<SyncRpcResult>;

    const summary: CategorySyncSummary = {
      syncRunId: result.syncRunId ?? 0,
      categoriesSeen: result.categoriesSeen ?? 0,
      attributesSeen: result.attributesSeen ?? 0,
      pathsSeen: result.pathsSeen ?? 0,
      categoriesDeactivated: result.categoriesDeactivated ?? 0,
    };

    log.info('Category tree applied', { ...summary });

    return summary;
  }

  async recordFailedRun(context: CategorySyncContext, message: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase.from('musgrave_sync_runs').insert({
      status: 'failed',
      spgid: context.spgid,
      source_url: context.sourceUrl,
      finished_at: new Date().toISOString(),
      error: message.slice(0, 2000),
    });

    if (error) {
      // Never mask the original failure with a bookkeeping one.
      log.error('Could not record the failed sync run', { message: error.message });
    }
  }

  async loadCategoryTree(includeInactive = false): Promise<unknown> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc('musgrave_category_tree', {
      p_include_inactive: includeInactive,
    });

    if (error) {
      throw new Error(`musgrave_category_tree failed: ${error.message}`);
    }

    return data;
  }

  /** category_id → ordered path ids, read from musgrave_category_paths. */
  private async loadCategoryPaths(): Promise<Map<number, string[]>> {
    const supabase = getSupabaseClient();
    const byCategory = new Map<number, string[]>();

    for (let from = 0; ; from += READ_PAGE_SIZE) {
      const { data, error } = await supabase
        .from('musgrave_category_paths')
        .select('category_id, position, path_category_id')
        .order('category_id', { ascending: true })
        .order('position', { ascending: true })
        .range(from, from + READ_PAGE_SIZE - 1);

      if (error) {
        throw new Error(`Reading musgrave_category_paths failed: ${error.message}`);
      }

      const rows = (data ?? []) as Record<string, unknown>[];
      for (const row of rows) {
        const categoryId = Number(row.category_id);
        const segment = String(row.path_category_id ?? '');
        if (!segment) continue;
        const existing = byCategory.get(categoryId);
        if (existing) existing.push(segment);
        else byCategory.set(categoryId, [segment]);
      }

      if (rows.length < READ_PAGE_SIZE) break;
    }

    return byCategory;
  }

  async listCategories(options: { includeInactive?: boolean } = {}): Promise<StoredCategory[]> {
    const supabase = getSupabaseClient();
    const categories: StoredCategory[] = [];
    const paths = await this.loadCategoryPaths();

    // PostgREST caps a response at 1000 rows, and the hierarchy is larger than
    // that, so read in pages rather than silently truncating.
    for (let from = 0; ; from += READ_PAGE_SIZE) {
      let query = supabase
        .from('musgrave_categories')
        .select('id, category_ref, musgrave_id, name, depth, sort_path')
        .order('sort_path', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + READ_PAGE_SIZE - 1);

      if (!options.includeInactive) query = query.eq('is_active', true);

      const { data, error } = await query;

      if (error) {
        throw new Error(`Reading musgrave_categories failed: ${error.message}`);
      }

      const rows = data ?? [];
      for (const row of rows as Record<string, unknown>[]) {
        const id = Number(row.id);
        const musgraveId = String(row.musgrave_id ?? '');
        // A category with no stored path still has to be addressable; its own id
        // is the best available fallback.
        const pathSegments = paths.get(id) ?? (musgraveId ? [musgraveId] : []);

        categories.push({
          id,
          musgraveId,
          categoryRef: String(row.category_ref ?? ''),
          name: String(row.name ?? ''),
          depth: Number(row.depth ?? 0),
          sortPath: (row.sort_path as string | null) ?? null,
          pathSegments,
        });
      }

      if (rows.length < READ_PAGE_SIZE) break;
    }

    log.info('Loaded categories', { count: categories.length });

    return categories;
  }
}
