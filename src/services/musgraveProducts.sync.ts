/**
 * Musgrave product synchronization.
 *
 *   login → personalization → spgid → for each stored category:
 *     GET /categories/{id}/products → paginate → parse → upsert by SKU
 *
 * Orchestration only. Fetching is in `musgraveProducts.api.ts`, parsing in
 * `musgraveProducts.parse.ts`, persistence in the product repository, and the
 * category list comes from the existing category repository. Authentication is
 * the shared session — one login for the whole run, reused by every request.
 *
 * Pagination follows the RESPONSE, never a fixed page count: it keeps requesting
 * while `offset < total`, using the `total` the API reports. Categories with 0
 * products, fewer than a page, exactly a page, or many pages all behave.
 *
 * One category failing does not stop the run; failures are collected and
 * reported at the end.
 */

import {
  DEFAULT_PAGE_SIZE,
  fetchCategoryProductsPage,
} from './musgraveProducts.api.js';
import { parseProductsPage, type ParsedProduct } from './musgraveProducts.parse.js';
import { getMusgraveSession } from './musgrave.service.js';
import { sleep } from './supplierSearch.js';
import {
  SupabaseMusgraveCategoryRepository,
  type MusgraveCategoryRepository,
  type StoredCategory,
} from '../repositories/musgraveCategory.repository.js';
import {
  SupabaseMusgraveProductRepository,
  type MusgraveProductRepository,
  type ProductSyncCounts,
  type ProductSyncStatus,
} from '../repositories/musgraveProduct.repository.js';
import { createLogger } from '../log.js';

const log = createLogger('musgrave:products:sync');

/** Pause between page requests, keeping the trade account human-paced. */
const DEFAULT_PAUSE_MS = 200;
/** Guard against a category that never advances (defensive, not expected). */
const MAX_PAGES_PER_CATEGORY = 2000;
/**
 * The API stops counting at 10,000: a category reporting exactly this is a
 * ceiling, not a real total. Verified — one category reported 10,000 while its
 * five direct children summed to 20,010. Such a category cannot be trusted to
 * expose its whole subtree, so its children are synced as well.
 */
const DEFAULT_CAPPED_TOTAL_THRESHOLD = 10_000;

export interface SyncMusgraveProductsOptions {
  categoryRepository?: MusgraveCategoryRepository;
  productRepository?: MusgraveProductRepository;
  /** Page size. Defaults to the website's 36. */
  amount?: number;
  /** Process at most this many categories (useful for a smoke run). */
  maxCategories?: number;
  /** Stop after this many pages per category. */
  maxPagesPerCategory?: number;
  pauseMs?: number;
  /** Fetch and parse without writing. */
  dryRun?: boolean;
  /** Only these Musgrave category ids. */
  onlyCategoryIds?: string[];
  /**
   * Include hierarchy root containers (depth 0, e.g. the tree's own container).
   * Off by default — they organise the tree rather than holding products.
   */
  includeRootCategories?: boolean;
  /**
   * Sync every category rather than only top-level ones. Fallback for a supplier
   * whose parent categories do NOT aggregate their descendants' products.
   */
  allCategories?: boolean;
  /**
   * A category reporting at least this many products is treated as capped by the
   * API rather than genuinely that size, and its children are synced too.
   */
  cappedTotalThreshold?: number;
}

export interface CategorySyncOutcome {
  categoryId: string;
  categoryRef: string;
  name: string;
  depth: number;
  total: number;
  pages: number;
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  durationMs: number;
  /** True when this category was reached by cap-triggered recursion. */
  viaCapExpansion?: boolean;
  /** True when its reported total hit the ceiling and its children were queued. */
  cappedTotal?: boolean;
  error?: string;
}

export interface SyncMusgraveProductsResult {
  syncRunId: number;
  spgid: string;
  dryRun: boolean;
  status: ProductSyncStatus;
  counts: ProductSyncCounts;
  categories: CategorySyncOutcome[];
  failed: CategorySyncOutcome[];
  /** Categories whose reported total hit the ceiling, so their children ran too. */
  cappedCategories: CategorySyncOutcome[];
  /** How many extra categories the cap recursion added to the run. */
  expandedFromCap: number;
  /** 'top-level' (default) or 'all-categories'. */
  scope: 'top-level' | 'all-categories';
  warnings: string[];
  durationMs: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = String(error);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Page through one category. Returns everything fetched plus the API's own
 * `total`, so the caller can log progress without re-deriving it.
 */
async function fetchCategoryProducts(
  category: StoredCategory,
  options: { amount: number; maxPages: number; pauseMs: number },
  onPage: (page: {
    products: ParsedProduct[];
    pageNumber: number;
    offset: number;
    total: number;
  }) => Promise<void>,
): Promise<{ total: number; pages: number; warnings: string[] }> {
  const warnings: string[] = [];
  let offset = 0;
  let total = 0;
  let pages = 0;

  for (;;) {
    if (pages >= options.maxPages) {
      warnings.push(
        `Category ${category.musgraveId} stopped at the ${options.maxPages}-page cap.`,
      );
      break;
    }

    if (pages > 0 && options.pauseMs > 0) await sleep(options.pauseMs);

    // The API addresses a category by its FULL path, not the leaf id.
    const response = await fetchCategoryProductsPage(category.pathSegments, {
      offset,
      amount: options.amount,
    });

    const page = parseProductsPage(response.data, { offset, amount: options.amount });
    warnings.push(...page.warnings.map((w) => `${category.musgraveId}: ${w}`));

    pages++;
    total = page.total;

    log.info('Page fetched', {
      category: category.musgraveId,
      name: category.name,
      page: pages,
      offset,
      total,
      products: page.products.length,
    });

    await onPage({ products: page.products, pageNumber: pages, offset, total });

    // Advance by what the API actually returned, not by the requested size.
    const advanced = page.elementCount;

    if (advanced === 0) {
      // Nothing came back. Either we are done, or the API is not advancing —
      // either way, continuing would loop forever.
      if (offset < total) {
        warnings.push(
          `Category ${category.musgraveId} returned 0 elements at offset ${offset} of ${total} — stopping early.`,
        );
      }
      break;
    }

    offset += advanced;

    if (offset >= total) break;
  }

  return { total, pages, warnings };
}

/**
 * Synchronize every stored category's products into Supabase.
 *
 * Idempotent: SKU is the identity, and the upsert only writes when tracked
 * fields actually differ, so a repeat run reports everything as unchanged.
 */
export async function syncMusgraveProducts(
  options: SyncMusgraveProductsOptions = {},
): Promise<SyncMusgraveProductsResult> {
  const categoryRepository =
    options.categoryRepository ?? new SupabaseMusgraveCategoryRepository();
  const productRepository = options.productRepository ?? new SupabaseMusgraveProductRepository();

  const amount = options.amount ?? DEFAULT_PAGE_SIZE;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const maxPages = options.maxPagesPerCategory ?? MAX_PAGES_PER_CATEGORY;
  const cappedTotalThreshold = options.cappedTotalThreshold ?? DEFAULT_CAPPED_TOTAL_THRESHOLD;
  const dryRun = Boolean(options.dryRun);

  const startedAt = Date.now();
  const warnings: string[] = [];

  // One login for the whole run — every subsequent request reuses this session.
  const session = await getMusgraveSession();
  log.info('Authenticated', { spgid: session.pgid });

  const allStored = await categoryRepository.listCategories();

  // Direct-children index, derived from the stored category paths. No category
  // id or name is ever hardcoded — the tree itself decides what recursion means.
  const childrenByParentId = new Map<string, StoredCategory[]>();
  for (const category of allStored) {
    if (category.pathSegments.length < 2) continue;
    const parentId = category.pathSegments[category.pathSegments.length - 2]!;
    const siblings = childrenByParentId.get(parentId);
    if (siblings) siblings.push(category);
    else childrenByParentId.set(parentId, [category]);
  }
  const childrenOf = (category: StoredCategory): StoredCategory[] =>
    (childrenByParentId.get(category.musgraveId) ?? []).filter(
      (c) => c.pathSegments.length > 0,
    );

  let categories = allStored;

  // The hierarchy root is a container, not a product category.
  if (!options.includeRootCategories) {
    const roots = categories.filter((c) => c.depth === 0);
    if (roots.length > 0) {
      log.info('Skipping hierarchy root container(s)', {
        skipped: roots.map((r) => r.musgraveId),
      });
      categories = categories.filter((c) => c.depth !== 0);
    }
  }

  // Default scope: top-level only. Parent categories aggregate their descendants'
  // products, so one request per top-level category covers the subtree — with the
  // cap recursion below catching the branches where that breaks down.
  const scope: 'top-level' | 'all-categories' = options.allCategories
    ? 'all-categories'
    : 'top-level';
  if (scope === 'top-level') {
    categories = categories.filter((c) => c.depth === 1);
  }

  // Without a path we cannot address the category at all.
  const unaddressable = categories.filter((c) => c.pathSegments.length === 0);
  if (unaddressable.length > 0) {
    warnings.push(
      `${unaddressable.length} category(ies) have no stored category path and were skipped.`,
    );
    categories = categories.filter((c) => c.pathSegments.length > 0);
  }

  if (options.onlyCategoryIds && options.onlyCategoryIds.length > 0) {
    const wanted = new Set(options.onlyCategoryIds);
    categories = categories.filter((c) => wanted.has(c.musgraveId));
  }
  if (options.maxCategories !== undefined) {
    categories = categories.slice(0, options.maxCategories);
  }

  log.info('Categories selected', {
    loaded: allStored.length,
    scope,
    selected: categories.length,
    cappedTotalThreshold,
  });

  if (categories.length === 0) {
    const message =
      'No categories found in musgrave_categories — run the category sync first (npm run sync:categories).';
    log.error(message);
    throw new Error(message);
  }

  const counts: ProductSyncCounts = {
    categoriesTotal: categories.length,
    categoriesProcessed: 0,
    categoriesFailed: 0,
    pagesFetched: 0,
    productsSeen: 0,
    productsInserted: 0,
    productsUpdated: 0,
    productsUnchanged: 0,
  };

  const syncRunId = dryRun ? 0 : await productRepository.startSyncRun(session.pgid, categories.length);

  log.info('Starting product sync', {
    categories: categories.length,
    amount,
    dryRun,
    syncRunId,
  });

  const outcomes: CategorySyncOutcome[] = [];

  // A queue rather than a plain loop: a category whose reported total hits the
  // ceiling pushes its direct children on, and the same rule then applies to
  // them, so the fallback is naturally recursive to any depth.
  const queue: { category: StoredCategory; viaCapExpansion: boolean }[] = categories.map(
    (category) => ({ category, viaCapExpansion: false }),
  );
  const queued = new Set<number>(categories.map((c) => c.id));
  const visited = new Set<number>();
  let expandedFromCap = 0;
  let position = 0;

  while (queue.length > 0) {
    const { category, viaCapExpansion } = queue.shift()!;
    if (visited.has(category.id)) continue;
    visited.add(category.id);
    position++;

    const categoryStartedAt = Date.now();
    const outcome: CategorySyncOutcome = {
      categoryId: category.musgraveId,
      categoryRef: category.categoryRef,
      name: category.name,
      depth: category.depth,
      total: 0,
      pages: 0,
      seen: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      durationMs: 0,
      ...(viaCapExpansion ? { viaCapExpansion: true } : {}),
    };

    log.info(`[${position}/${position + queue.length}] ${category.name}`, {
      categoryId: category.musgraveId,
      depth: category.depth,
      ...(viaCapExpansion ? { viaCapExpansion: true } : {}),
    });

    try {
      const { total, pages, warnings: categoryWarnings } = await fetchCategoryProducts(
        category,
        { amount, maxPages, pauseMs },
        async ({ products }) => {
          if (products.length === 0) return;

          if (dryRun) {
            outcome.seen += products.length;
            return;
          }

          const result = await productRepository.upsertProducts(products, {
            categoryId: category.id,
            categoryRef: category.categoryRef,
            syncRunId,
          });

          outcome.seen += result.seen;
          outcome.inserted += result.inserted;
          outcome.updated += result.updated;
          outcome.unchanged += result.unchanged;
        },
      );

      outcome.total = total;
      outcome.pages = pages;
      warnings.push(...categoryWarnings);

      // The API stops counting at the ceiling, so a category reporting it cannot
      // be trusted to expose its whole subtree. Sync its children as well — the
      // SKU upsert de-duplicates whatever overlaps.
      if (total >= cappedTotalThreshold) {
        outcome.cappedTotal = true;
        const children = childrenOf(category).filter((c) => !queued.has(c.id));

        if (children.length > 0) {
          for (const child of children) queued.add(child.id);
          expandedFromCap += children.length;

          log.warn('Reported total hit the ceiling — recursing into child categories', {
            categoryId: category.musgraveId,
            name: category.name,
            reportedTotal: total,
            threshold: cappedTotalThreshold,
            childrenQueued: children.length,
          });

          queue.push(...children.map((child) => ({ category: child, viaCapExpansion: true })));
        } else if (childrenOf(category).length === 0) {
          const message =
            `Category ${category.musgraveId} ("${category.name}") reported ${total} products, ` +
            'at the API ceiling, but has no child categories to fall back to — products beyond the ceiling may be unreachable.';
          warnings.push(message);
          log.warn(message);
        }
      }

      counts.categoriesProcessed++;
      counts.pagesFetched += pages;
      counts.productsSeen += outcome.seen;
      counts.productsInserted += outcome.inserted;
      counts.productsUpdated += outcome.updated;
      counts.productsUnchanged += outcome.unchanged;
    } catch (error) {
      // A failing category must not end the run.
      outcome.error = errorMessage(error);
      counts.categoriesFailed++;
      log.error('Category failed', {
        categoryId: category.musgraveId,
        name: category.name,
        message: outcome.error,
      });
    }

    outcome.durationMs = Date.now() - categoryStartedAt;
    outcomes.push(outcome);

    log.info(`[${position}/${position + queue.length}] done`, {
      categoryId: category.musgraveId,
      total: outcome.total,
      pages: outcome.pages,
      inserted: outcome.inserted,
      updated: outcome.updated,
      unchanged: outcome.unchanged,
      ...(outcome.cappedTotal ? { cappedTotal: true } : {}),
      processedSoFar: counts.productsSeen,
      elapsedMs: Date.now() - startedAt,
    });
  }

  // Recursion can add categories after the run started; report what was actually
  // attempted rather than the size of the initial selection.
  counts.categoriesTotal = outcomes.length;

  const failed = outcomes.filter((o) => o.error);
  const status: ProductSyncStatus =
    counts.categoriesFailed === 0
      ? 'success'
      : counts.categoriesProcessed === 0
        ? 'failed'
        : 'partial';

  if (!dryRun) {
    await productRepository.finishSyncRun(
      syncRunId,
      status,
      counts,
      failed.length > 0
        ? `${failed.length} category(ies) failed: ${failed.map((f) => f.categoryId).join(', ')}`
        : undefined,
    );
  }

  const result: SyncMusgraveProductsResult = {
    syncRunId,
    spgid: session.pgid,
    dryRun,
    status,
    scope,
    counts,
    categories: outcomes,
    failed,
    cappedCategories: outcomes.filter((o) => o.cappedTotal),
    expandedFromCap,
    warnings,
    durationMs: Date.now() - startedAt,
  };

  log.info('Product sync complete', {
    status,
    scope,
    ...counts,
    cappedCategories: result.cappedCategories.length,
    expandedFromCap,
    durationMs: result.durationMs,
  });

  return result;
}
