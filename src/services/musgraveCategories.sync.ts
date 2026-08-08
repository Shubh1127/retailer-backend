/**
 * Musgrave category synchronization.
 *
 *   login → personalization → spgid → GET /categories → parse → Supabase
 *
 * Orchestration only: fetching lives in `musgraveCategories.api.ts`, parsing in
 * `musgraveCategories.parse.ts`, persistence in the repository. The spgid comes
 * from the existing personalization session — it is never hardcoded and is
 * recorded on the sync run for traceability.
 *
 * Idempotent: the same tree applied twice changes nothing but timestamps.
 */

import { fetchMusgraveCategoryTree } from './musgraveCategories.api.js';
import { parseCategoryTree, type ParsedCategoryTree } from './musgraveCategories.parse.js';
import {
  SupabaseMusgraveCategoryRepository,
  type CategorySyncContext,
  type MusgraveCategoryRepository,
} from '../repositories/musgraveCategory.repository.js';
import { createLogger } from '../log.js';

const log = createLogger('musgrave:categories:sync');

export interface SyncMusgraveCategoriesOptions {
  /** Swap the persistence layer (tests, alternative backends). */
  repository?: MusgraveCategoryRepository;
  /** Extra/overridden query params for the category endpoint. */
  query?: Record<string, string>;
  /** Fetch and parse but write nothing — for validating the response shape. */
  dryRun?: boolean;
}

export interface SyncMusgraveCategoriesResult {
  /** 0 on a dry run, since nothing was written. */
  syncRunId: number;
  spgid: string;
  sourceUrl: string;
  dryRun: boolean;
  categories: number;
  attributes: number;
  paths: number;
  maxDepth: number;
  categoriesDeactivated: number;
  warnings: string[];
  durationMs: number;
}

/**
 * Synchronize the Musgrave category hierarchy into Supabase.
 *
 * Throws on an unrecoverable failure (auth, transport, malformed tree, database
 * error) after recording a failed sync run. Parse-level oddities are returned as
 * `warnings` rather than aborting a run that is otherwise good.
 */
export async function syncMusgraveCategories(
  options: SyncMusgraveCategoriesOptions = {},
): Promise<SyncMusgraveCategoriesResult> {
  const repository = options.repository ?? new SupabaseMusgraveCategoryRepository();
  const startedAt = Date.now();

  log.info('Starting category sync', { dryRun: Boolean(options.dryRun) });

  // 1. Fetch — the client resolves the session and its spgid internally.
  const response = await fetchMusgraveCategoryTree(options.query ?? {});
  const context: CategorySyncContext = {
    spgid: response.spgid,
    sourceUrl: response.url,
  };

  // 2. Parse.
  let parsed: ParsedCategoryTree;
  try {
    parsed = parseCategoryTree(response.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Could not parse the category tree', { message });
    if (!options.dryRun) await repository.recordFailedRun(context, message);
    throw error;
  }

  if (parsed.nodes.length === 0) {
    // Wiping the tree because of an envelope change would be far worse than
    // failing loudly, so an empty parse is treated as an error.
    const message =
      'Category tree parsed to zero categories — the response envelope may have changed. Refusing to apply.';
    log.error(message, { sourceUrl: context.sourceUrl });
    if (!options.dryRun) await repository.recordFailedRun(context, message);
    throw new Error(message);
  }

  for (const warning of parsed.warnings) log.warn(warning);

  const base = {
    spgid: context.spgid,
    sourceUrl: context.sourceUrl,
    categories: parsed.counts.categories,
    attributes: parsed.counts.attributes,
    paths: parsed.counts.paths,
    maxDepth: parsed.counts.maxDepth,
    warnings: parsed.warnings,
  };

  // 3. Persist.
  if (options.dryRun) {
    log.info('Dry run — nothing written', { categories: parsed.counts.categories });
    return {
      ...base,
      syncRunId: 0,
      dryRun: true,
      categoriesDeactivated: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const summary = await repository.saveCategoryTree(parsed.nodes, context);
    const result: SyncMusgraveCategoriesResult = {
      ...base,
      syncRunId: summary.syncRunId,
      dryRun: false,
      categoriesDeactivated: summary.categoriesDeactivated,
      durationMs: Date.now() - startedAt,
    };

    log.info('Category sync complete', {
      syncRunId: result.syncRunId,
      categories: result.categories,
      attributes: result.attributes,
      paths: result.paths,
      deactivated: result.categoriesDeactivated,
      durationMs: result.durationMs,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Category sync failed', { message });
    await repository.recordFailedRun(context, message);
    throw error;
  }
}
