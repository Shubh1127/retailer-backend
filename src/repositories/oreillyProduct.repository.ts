/**
 * Supabase persistence for the O'Reilly catalogue.
 *
 * Mirrors the Musgrave product repository: an RPC does the listing upsert in
 * one statement per page and reports insert/update/unchanged, and sync runs are
 * recorded for observability.
 *
 * THE STAGES OWN DIFFERENT COLUMNS.
 *
 * `upsertListing` never touches EAN, pack or size; `saveDetails` never touches
 * price or name. That separation is what makes the sync resumable: a second
 * listing pass cannot blank an EAN that enrichment already found, and an
 * enrichment pass cannot resurrect a stale price.
 *
 * Unlike the Musgrave repository, writes here are NOT best-effort. A catalogue
 * that silently fails to store is worse than one that fails loudly — the whole
 * point is having the data locally.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { createLogger } from '../log.js';
import type { ListedProduct, ParsedCategory, ProductDetails } from '../services/oreillyCrawl.parse.js';

const log = createLogger('oreilly:products:repository');

/**
 * `prod_group` for a row that represents a whole department.
 *
 * Zero rather than NULL, because NULLs are DISTINCT inside a unique constraint
 * — a NULL marker meant `(8, NULL)` never conflicted with itself and every sync
 * inserted a duplicate department. The live site numbers its groups from 1, so
 * zero cannot collide with a real one.
 */
const DEPARTMENT_GROUP = 0;

export type ProductSyncStatus = 'running' | 'success' | 'partial' | 'failed';

export interface ListingUpsertResult {
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface OreillySyncCounts {
  departmentsTotal: number;
  departmentsProcessed: number;
  departmentsFailed: number;
  pagesFetched: number;
  productsSeen: number;
  productsInserted: number;
  productsUpdated: number;
  productsUnchanged: number;
  detailsAttempted: number;
  detailsSucceeded: number;
  detailsFailed: number;
  throttleEvents: number;
  reauthEvents: number;
}

/** A product still awaiting its detail page. */
export interface PendingProduct {
  id: number;
  productCode: string;
  name?: string;
  productUrl?: string;
}

export interface StoredOreillyCategory {
  id: number;
  deptCode: number;
  prodGroup?: number;
  name: string;
}

export interface OreillyProductRepository {
  startSyncRun(departmentsTotal: number): Promise<number>;
  updateSyncRunProgress(syncRunId: number, counts: OreillySyncCounts): Promise<void>;
  listSyncRuns(limit?: number): Promise<Record<string, unknown>[]>;
  finishSyncRun(
    syncRunId: number,
    status: ProductSyncStatus,
    counts: OreillySyncCounts,
    error?: string,
  ): Promise<void>;
  upsertCategories(categories: readonly ParsedCategory[]): Promise<StoredOreillyCategory[]>;
  upsertListing(
    products: readonly ListedProduct[],
    context: { categoryId?: number; deptCode?: number; prodGroup?: number; syncRunId: number },
  ): Promise<ListingUpsertResult>;
  listPendingDetails(limit?: number): Promise<PendingProduct[]>;
  countPendingDetails(): Promise<number>;
  saveDetails(productId: number, details: ProductDetails): Promise<void>;
  recordDetailFailure(productId: number, message: string): Promise<void>;
}

export class SupabaseOreillyProductRepository implements OreillyProductRepository {
  async startSyncRun(departmentsTotal: number): Promise<number> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('oreilly_product_sync_runs')
      .insert({ departments_total: departmentsTotal })
      .select('id')
      .single();

    if (error) throw new Error(`Could not start an O'Reilly sync run: ${error.message}`);

    const id = Number((data as { id: number }).id);
    log.info('Sync run started', { syncRunId: id, departmentsTotal });
    return id;
  }

  /**
   * Write the counters mid-run, so something watching can see progress.
   *
   * The sync previously touched this row twice — once at the start, once at the
   * end — which is fine for a CLI that prints as it goes and useless to a
   * dashboard, where a 45-minute run would show no movement whatsoever until it
   * finished.
   *
   * Best-effort on purpose: this is observability. A failed progress write must
   * never abort a crawl that is otherwise fine.
   */
  async updateSyncRunProgress(
    syncRunId: number,
    counts: OreillySyncCounts,
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('oreilly_product_sync_runs')
      .update({
        departments_processed: counts.departmentsProcessed,
        departments_failed: counts.departmentsFailed,
        pages_fetched: counts.pagesFetched,
        products_seen: counts.productsSeen,
        products_inserted: counts.productsInserted,
        products_updated: counts.productsUpdated,
        products_unchanged: counts.productsUnchanged,
        details_attempted: counts.detailsAttempted,
        details_succeeded: counts.detailsSucceeded,
        details_failed: counts.detailsFailed,
        throttle_events: counts.throttleEvents,
        reauth_events: counts.reauthEvents,
      })
      .eq('id', syncRunId);

    if (error) {
      log.warn('Could not write sync progress', { syncRunId, message: error.message });
    }
  }

  async listSyncRuns(limit = 10): Promise<Record<string, unknown>[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('oreilly_product_sync_runs')
      .select('*')
      .order('id', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Could not list sync runs: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  }

  async finishSyncRun(
    syncRunId: number,
    status: ProductSyncStatus,
    counts: OreillySyncCounts,
    error?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const { error: updateError } = await supabase
      .from('oreilly_product_sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        status,
        departments_total: counts.departmentsTotal,
        departments_processed: counts.departmentsProcessed,
        departments_failed: counts.departmentsFailed,
        pages_fetched: counts.pagesFetched,
        products_seen: counts.productsSeen,
        products_inserted: counts.productsInserted,
        products_updated: counts.productsUpdated,
        products_unchanged: counts.productsUnchanged,
        details_attempted: counts.detailsAttempted,
        details_succeeded: counts.detailsSucceeded,
        details_failed: counts.detailsFailed,
        throttle_events: counts.throttleEvents,
        reauth_events: counts.reauthEvents,
        ...(error ? { error: error.slice(0, 2000) } : {}),
      })
      .eq('id', syncRunId);

    // Never mask the real outcome with a bookkeeping failure.
    if (updateError) {
      log.error('Could not finish the sync run record', { syncRunId, message: updateError.message });
    }
  }

  async upsertCategories(
    categories: readonly ParsedCategory[],
  ): Promise<StoredOreillyCategory[]> {
    if (categories.length === 0) return [];

    const supabase = getSupabaseClient();

    // `prod_group = 0` marks the whole department. NOT null: NULLs are distinct
    // inside a unique constraint, so a NULL marker made every sync insert a
    // fresh department row instead of matching the existing one.
    const { error } = await supabase.from('oreilly_categories').upsert(
      categories.map((category) => ({
        dept_code: category.deptCode,
        prod_group: category.prodGroup ?? DEPARTMENT_GROUP,
        name: category.name,
        parent_name: category.parentName ?? null,
      })),
      { onConflict: 'dept_code,prod_group' },
    );

    if (error) throw new Error(`Could not store O'Reilly categories: ${error.message}`);

    const { data, error: readError } = await supabase
      .from('oreilly_categories')
      .select('id, dept_code, prod_group, name');

    if (readError) throw new Error(`Could not read O'Reilly categories: ${readError.message}`);

    return (data ?? []).map((row: Record<string, any>) => {
      const group = Number(row.prod_group);
      return {
        id: Number(row.id),
        deptCode: Number(row.dept_code),
        // The sentinel is a storage detail; callers see a department as simply
        // having no group, exactly as the parser reports it.
        ...(group === DEPARTMENT_GROUP ? {} : { prodGroup: group }),
        name: String(row.name),
      };
    });
  }

  async upsertListing(
    products: readonly ListedProduct[],
    context: { categoryId?: number; deptCode?: number; prodGroup?: number; syncRunId: number },
  ): Promise<ListingUpsertResult> {
    if (products.length === 0) return { seen: 0, inserted: 0, updated: 0, unchanged: 0 };

    /**
     * DE-DUPLICATED BY CODE, because a single listing page can legitimately
     * list the same product twice.
     *
     * `INSERT ... ON CONFLICT DO UPDATE` refuses to touch one row twice in the
     * same statement — "cannot affect row a second time" — so one repeated code
     * fails the whole page. Observed on Confectionery page 8, which aborted the
     * department and cost 1,290 of its 1,640 products while the run still
     * reported success for every other department.
     *
     * The first occurrence wins: entries on one page describe the same product,
     * so which one survives does not matter, only that exactly one does.
     */
    const byCode = new Map<string, ListedProduct>();
    for (const product of products) {
      if (!byCode.has(product.productCode)) byCode.set(product.productCode, product);
    }

    const deduped = [...byCode.values()];

    if (deduped.length !== products.length) {
      log.info('Listing page repeated a product code', {
        page: products.length,
        unique: deduped.length,
        dropped: products.length - deduped.length,
      });
    }

    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc('oreilly_upsert_products', {
      p_products: deduped as unknown as Record<string, unknown>[],
      p_category_id: context.categoryId ?? null,
      p_dept_code: context.deptCode ?? null,
      p_prod_group: context.prodGroup ?? null,
      p_sync_id: context.syncRunId,
    });

    if (error) {
      throw new Error(
        `oreilly_upsert_products failed: ${error.message}` +
          (error.hint ? ` (hint: ${error.hint})` : ''),
      );
    }

    const result = (data ?? {}) as Partial<ListingUpsertResult>;

    return {
      seen: result.seen ?? deduped.length,
      inserted: result.inserted ?? 0,
      updated: result.updated ?? 0,
      unchanged: result.unchanged ?? 0,
    };
  }

  /**
   * Products whose detail page has never been read.
   *
   * `details_fetched_at IS NULL` is the entire resume condition — it is set
   * whether or not the page yielded an EAN, so a product that genuinely has
   * none leaves the queue after one attempt rather than being retried for ever.
   */
  async listPendingDetails(limit = 1000): Promise<PendingProduct[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('oreilly_products')
      .select('id, product_code, name, product_url')
      .is('details_fetched_at', null)
      .not('product_url', 'is', null)
      .order('id')
      .limit(limit);

    if (error) throw new Error(`Could not list pending products: ${error.message}`);

    return (data ?? []).map((row: Record<string, any>) => ({
      id: Number(row.id),
      productCode: String(row.product_code),
      ...(row.name ? { name: String(row.name) } : {}),
      ...(row.product_url ? { productUrl: String(row.product_url) } : {}),
    }));
  }

  async countPendingDetails(): Promise<number> {
    const supabase = getSupabaseClient();

    const { count, error } = await supabase
      .from('oreilly_products')
      .select('id', { count: 'exact', head: true })
      .is('details_fetched_at', null)
      .not('product_url', 'is', null);

    if (error) throw new Error(`Could not count pending products: ${error.message}`);
    return count ?? 0;
  }

  async saveDetails(productId: number, details: ProductDetails): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('oreilly_products')
      .update({
        ean: details.ean ?? null,
        units_per_case: details.unitsPerCase ?? null,
        unit_size: details.unitSize ?? null,
        uom: details.uom ?? null,
        size_text: details.sizeText ?? null,
        // Stamped even when the page yielded nothing — see listPendingDetails.
        details_fetched_at: new Date().toISOString(),
        details_error: null,
      })
      .eq('id', productId);

    if (error) throw new Error(`Could not save details for product ${productId}: ${error.message}`);
  }

  /**
   * Record that a detail fetch failed.
   *
   * `details_fetched_at` is deliberately left NULL, so the product stays in the
   * pending queue and the next run retries it. The message is kept so a
   * systematic failure is visible without re-running anything.
   */
  async recordDetailFailure(productId: number, message: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('oreilly_products')
      .update({ details_error: message.slice(0, 500) })
      .eq('id', productId);

    if (error) {
      log.warn('Could not record a detail failure', { productId, message: error.message });
    }
  }
}
