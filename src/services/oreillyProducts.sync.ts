/**
 * O'Reilly catalogue synchronization.
 *
 *   login → read the category tree from the menu → for each department:
 *     GET gridlist.asp?DeptCode=&page=N → parse → upsert by product code
 *   then, for every product with no detail page read yet:
 *     GET DetailsPortal.asp → parse → update EAN / pack / size
 *
 * Orchestration only. Fetching and its defences are in `oreillyCrawl.http.ts`,
 * parsing in `oreillyCrawl.parse.ts`, persistence in the product repository.
 *
 * ONE COMMAND, TWO STAGES, WRITTEN AS IT GOES
 *
 * Listings are persisted page by page, so ~4 minutes in there is a usable
 * catalogue with prices even though enrichment has hours to run. Enrichment
 * then updates each product as its page returns. Nothing is buffered to the
 * end, which is what makes an interrupted run cost nothing.
 *
 * PAGINATION TERMINATES ON A REPEAT, NOT ON EMPTY
 *
 * Verified against the live site: an out-of-range page CLAMPS and re-serves the
 * last page rather than returning nothing. A loop waiting for zero products
 * would never exit and would re-request the same page for ever.
 *
 * ONE DEPARTMENT FAILING DOES NOT END THE RUN. Failures are collected and
 * reported, matching the Musgrave sync.
 */

import {
  SupabaseOreillyProductRepository,
  type OreillyProductRepository,
  type OreillySyncCounts,
  type ProductSyncStatus,
} from '../repositories/oreillyProduct.repository.js';
import { BASE_URL, ensureSession } from './oreilly.service.js';
import { ThrottleState, crawlGet } from './oreillyCrawl.http.js';
import {
  isListingPage,
  parseCategoryTree,
  parseDetailPage,
  parseListingPage,
  type ParsedCategory,
} from './oreillyCrawl.parse.js';
import { sleep } from './supplierSearch.js';
import { createLogger } from '../log.js';
import * as cheerio from 'cheerio';

const log = createLogger('oreilly:products:sync');

/** Between listing pages. The listing stage is sequential and already brisk. */
const DEFAULT_PAGE_PAUSE_MS = 120;
/**
 * Concurrent detail fetches. Three, measured: 1→3 more than doubles throughput,
 * while 3→5 buys ~20% more and stretches the slowest request from 2.9s to 4.1s
 * — a server queueing rather than serving, which is where throttling begins.
 */
const DEFAULT_DETAIL_CONCURRENCY = 3;
/** Runaway guard. 60 pages is 3,000 products in one department. */
const MAX_PAGES_PER_DEPARTMENT = 60;
/**
 * Products per listing page, as the site serves them. Used only to spot a
 * department that ended on a FULL page, which is the shape of a truncation
 * rather than of a real ending.
 */
const LISTING_PAGE_SIZE = 50;

export interface SyncOreillyProductsOptions {
  repository?: OreillyProductRepository;
  /** Concurrent detail fetches. Defaults to 3. */
  detailConcurrency?: number;
  pagePauseMs?: number;
  maxPagesPerDepartment?: number;
  /** Only these department codes. */
  onlyDeptCodes?: number[];
  /** Stop the listing stage after this many departments (smoke runs). */
  maxDepartments?: number;
  /** Enrich at most this many products (smoke runs). */
  maxDetails?: number;
  /** Crawl listings only. The catalogue works without EANs, just less well. */
  skipDetails?: boolean;
  /** Enrich only — skips straight to whatever is still pending. */
  skipListings?: boolean;
  /** Fetch and parse without writing. */
  dryRun?: boolean;
  /**
   * Called as the run advances, for anything watching live.
   *
   * Separate from the database write below: an in-process caller (the admin
   * API) should not have to wait on, or depend on, a Supabase round trip to
   * know where a crawl has got to.
   */
  onProgress?: (progress: SyncProgress) => void;
}

export interface SyncProgress {
  stage: 'listings' | 'details' | 'finished';
  counts: OreillySyncCounts;
  /** What is happening right now, e.g. "Confectionery p12" or "3184/5576". */
  detail: string;
  elapsedMs: number;
}

export interface DepartmentOutcome {
  deptCode: number;
  name: string;
  pages: number;
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  durationMs: number;
  error?: string;
}

export interface SyncOreillyProductsResult {
  syncRunId: number;
  dryRun: boolean;
  status: ProductSyncStatus;
  counts: OreillySyncCounts;
  departments: DepartmentOutcome[];
  failed: DepartmentOutcome[];
  warnings: string[];
  durationMs: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = String(error);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** "1h 04m 12s" — durations here run to hours, which bare ms does not convey. */
function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Read the department/group tree from the menu any authenticated page renders.
 *
 * One request, and it doubles as proof the session works before a long crawl
 * commits to anything.
 */
async function loadCategoryTree(throttle: ThrottleState): Promise<ParsedCategory[]> {
  const { html } = await crawlGet(`${BASE_URL}/products/dashboard.asp`, {
    label: 'category tree',
    throttle,
  });

  const categories = parseCategoryTree(html);

  if (categories.length === 0) {
    throw new Error(
      "Could not read O'Reilly's category menu — the page rendered but contained " +
        'no gridlist links. The site layout may have changed.',
    );
  }

  return categories;
}

export async function syncOreillyProducts(
  options: SyncOreillyProductsOptions = {},
): Promise<SyncOreillyProductsResult> {
  const repository = options.repository ?? new SupabaseOreillyProductRepository();
  const pagePauseMs = options.pagePauseMs ?? DEFAULT_PAGE_PAUSE_MS;
  const maxPages = options.maxPagesPerDepartment ?? MAX_PAGES_PER_DEPARTMENT;
  const dryRun = Boolean(options.dryRun);

  const throttle = new ThrottleState(
    options.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY,
  );

  const startedAt = Date.now();
  const warnings: string[] = [];

  const counts: OreillySyncCounts = {
    departmentsTotal: 0,
    departmentsProcessed: 0,
    departmentsFailed: 0,
    pagesFetched: 0,
    productsSeen: 0,
    productsInserted: 0,
    productsUpdated: 0,
    productsUnchanged: 0,
    detailsAttempted: 0,
    detailsSucceeded: 0,
    detailsFailed: 0,
    throttleEvents: 0,
    reauthEvents: 0,
  };

  // One login for the whole run; every request reuses it and re-authenticates
  // on its own if the session lapses mid-crawl.
  await ensureSession();
  log.info('Authenticated');

  const tree = await loadCategoryTree(throttle);

  // Departments are what gets crawled: `?chkpm=MALL` returns the whole
  // department, so one pass covers every group inside it. The groups are still
  // stored, because they are how a product is traced back to where it sits.
  let departments = tree.filter((c) => c.prodGroup === undefined);

  if (options.onlyDeptCodes?.length) {
    const wanted = new Set(options.onlyDeptCodes);
    departments = departments.filter((d) => wanted.has(d.deptCode));
  }
  if (options.maxDepartments !== undefined) {
    departments = departments.slice(0, options.maxDepartments);
  }

  counts.departmentsTotal = departments.length;

  // Counted from the TREE, not from the filtered selection — otherwise a run
  // scoped to one department reports the site as having one department.
  const groupsInTree = tree.filter((c) => c.prodGroup !== undefined).length;

  log.info('Category tree loaded', {
    categories: tree.length,
    departmentsInTree: tree.length - groupsInTree,
    groupsInTree,
    departmentsSelected: departments.length,
  });

  const syncRunId = dryRun ? 0 : await repository.startSyncRun(departments.length);

  /**
   * Report progress, and persist it at most every few seconds.
   *
   * Throttled deliberately: this is called per page and per product, and one
   * database write per detail fetch would add ~5,500 round trips to a run whose
   * whole point is the 5,500 it already makes.
   */
  let lastPersistedAt = 0;
  const report = (stage: SyncProgress['stage'], detail: string): void => {
    options.onProgress?.({
      stage,
      counts: { ...counts },
      detail,
      elapsedMs: Date.now() - startedAt,
    });

    if (dryRun) return;
    const now = Date.now();
    if (stage !== 'finished' && now - lastPersistedAt < 5_000) return;
    lastPersistedAt = now;
    void repository.updateSyncRunProgress(syncRunId, counts);
  };

  const storedCategories = dryRun ? [] : await repository.upsertCategories(tree);
  const categoryIdFor = new Map(
    storedCategories
      .filter((c) => c.prodGroup === undefined)
      .map((c) => [c.deptCode, c.id]),
  );

  const outcomes: DepartmentOutcome[] = [];

  // ---- Stage 1: listings --------------------------------------------------

  if (!options.skipListings) {
    log.info('=== STAGE 1: listings ===', { departments: departments.length });

    for (const [index, department] of departments.entries()) {
      const position = index + 1;
      const departmentStartedAt = Date.now();
      const outcome: DepartmentOutcome = {
        deptCode: department.deptCode,
        name: department.name,
        pages: 0,
        seen: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        durationMs: 0,
      };

      log.info(`[${position}/${departments.length}] ${department.name}`, {
        deptCode: department.deptCode,
      });

      try {
        const listing = `${BASE_URL}/products/gridlist.asp?DeptCode=${department.deptCode}&chkpm=MALL`;
        let previousSignature = '';
        let previousCount = 0;

        /** Fetch and parse one page. Throws only when the page is unusable. */
        const fetchPage = async (page: number) => {
          const { html } = await crawlGet(`${listing}&page=${page}`, {
            label: `${department.name} p${page}`,
            position,
            total: departments.length,
            context: { deptCode: department.deptCode, page },
            throttle,
          });

          const $ = cheerio.load(html);
          if (!isListingPage($)) return undefined;

          return parseListingPage(html);
        };

        for (let page = 1; page <= maxPages; page += 1) {
          let parsed = await fetchPage(page);
          counts.pagesFetched += 1;
          outcome.pages = page;

          const isEnd = (result: typeof parsed) =>
            !result || result.products.length === 0 || result.signature === previousSignature;

          /**
           * AN END SIGNAL IS CONFIRMED, NEVER TRUSTED FIRST TIME.
           *
           * Empty and repeated pages are how this listing ends — out-of-range
           * pages clamp and re-serve the last one rather than returning
           * nothing. They are ALSO what a transient hiccup looks like, and
           * believing one silently truncates a department while the run still
           * reports success. That is not hypothetical: it cost Confectionery
           * 1,290 of its 1,640 products, stopping at page 8 of 34 because one
           * page came back wrong.
           *
           * So the same page is asked for again before the department is
           * closed. A real end repeats; a hiccup does not.
           */
          if (isEnd(parsed)) {
            await sleep(1_500);
            const retry = await fetchPage(page);
            counts.pagesFetched += 1;

            if (!isEnd(retry)) {
              log.warn(
                `[${position}/${departments.length}] ${department.name} p${page} — ` +
                  'looked like the end but recovered on retry; continuing',
                { deptCode: department.deptCode, page },
              );
              parsed = retry;
            } else {
              /**
               * A department that ends on a FULL page is suspicious: the last
               * page of a real listing is nearly always short. Reported rather
               * than silently accepted, because the alternative is a quietly
               * incomplete catalogue.
               */
              if (previousCount === LISTING_PAGE_SIZE) {
                const message =
                  `Department ${department.deptCode} ("${department.name}") ended at page ` +
                  `${page} straight after a full ${LISTING_PAGE_SIZE}-product page — it may be ` +
                  'truncated. Re-run to confirm.';
                warnings.push(message);
                log.warn(message);
              }
              break;
            }
          }

          const { products, signature } = parsed!;
          previousSignature = signature;
          previousCount = products.length;

          if (!dryRun) {
            const result = await repository.upsertListing(products, {
              ...(categoryIdFor.get(department.deptCode) !== undefined
                ? { categoryId: categoryIdFor.get(department.deptCode)! }
                : {}),
              deptCode: department.deptCode,
              syncRunId,
            });

            outcome.seen += result.seen;
            outcome.inserted += result.inserted;
            outcome.updated += result.updated;
            outcome.unchanged += result.unchanged;
          } else {
            outcome.seen += products.length;
          }

          log.info(
            `[${position}/${departments.length}] ${department.name} p${page} — ` +
              `${products.length} products (${outcome.seen} in this department, ` +
              `${counts.productsSeen + outcome.seen} total)`,
            { deptCode: department.deptCode },
          );

          report(
            'listings',
            `${department.name} p${page} — ${counts.productsSeen + outcome.seen} products`,
          );

          if (page === maxPages) {
            warnings.push(
              `Department ${department.deptCode} stopped at the ${maxPages}-page cap.`,
            );
          }

          if (pagePauseMs > 0) await sleep(pagePauseMs);
        }

        counts.departmentsProcessed += 1;
        counts.productsSeen += outcome.seen;
        counts.productsInserted += outcome.inserted;
        counts.productsUpdated += outcome.updated;
        counts.productsUnchanged += outcome.unchanged;
      } catch (error) {
        outcome.error = errorMessage(error);
        counts.departmentsFailed += 1;
        log.error(`[${position}/${departments.length}] ${department.name} FAILED`, {
          deptCode: department.deptCode,
          message: outcome.error,
        });
      }

      outcome.durationMs = Date.now() - departmentStartedAt;
      outcomes.push(outcome);

      log.info(
        `[${position}/${departments.length}] ${department.name} done — ` +
          `${outcome.pages} pages, ${outcome.seen} products ` +
          `(+${outcome.inserted} new, ~${outcome.updated} changed)`,
        { elapsed: humanDuration(Date.now() - startedAt) },
      );
    }

    log.info('=== STAGE 1 complete ===', {
      products: counts.productsSeen,
      inserted: counts.productsInserted,
      updated: counts.productsUpdated,
      pages: counts.pagesFetched,
      elapsed: humanDuration(Date.now() - startedAt),
    });
  }

  // ---- Stage 2: enrichment ------------------------------------------------

  if (!options.skipDetails && !dryRun) {
    const pendingTotal = await repository.countPendingDetails();
    const target =
      options.maxDetails !== undefined
        ? Math.min(options.maxDetails, pendingTotal)
        : pendingTotal;

    log.info('=== STAGE 2: detail pages ===', {
      pending: pendingTotal,
      willFetch: target,
      concurrency: throttle.lanes,
      estimate: humanDuration((target / Math.max(1, throttle.lanes)) * 550),
    });

    const stageStartedAt = Date.now();
    let done = 0;

    while (done < target) {
      const batch = await repository.listPendingDetails(
        Math.min(500, target - done),
      );
      if (batch.length === 0) break;

      // Re-read every item, because `lanes` can drop mid-batch when the
      // supplier pushes back. Slicing by the CURRENT value is what makes the
      // backoff apply to work not yet started.
      let cursor = 0;

      while (cursor < batch.length) {
        const lanes = Math.max(1, throttle.lanes);
        const slice = batch.slice(cursor, cursor + lanes);
        cursor += slice.length;

        await Promise.all(
          slice.map(async (product) => {
            const position = done + 1;
            done += 1;
            counts.detailsAttempted += 1;

            if (!product.productUrl) {
              counts.detailsFailed += 1;
              return;
            }

            try {
              const { html } = await crawlGet(product.productUrl, {
                label: `${product.productCode} ${product.name ?? ''}`.trim(),
                position,
                total: target,
                context: { productCode: product.productCode },
                throttle,
              });

              await repository.saveDetails(product.id, parseDetailPage(html));
              counts.detailsSucceeded += 1;
            } catch (error) {
              // One dead product page must not end a run of thousands.
              counts.detailsFailed += 1;
              const message = errorMessage(error);
              await repository.recordDetailFailure(product.id, message);
              log.error(`[${position}/${target}] ${product.productCode} FAILED`, { message });
            }
          }),
        );

        report('details', `${done}/${target} products enriched`);

        // Progress and ETA, at a readable cadence rather than every request.
        if (done % 50 === 0 || done >= target) {
          const elapsed = Date.now() - stageStartedAt;
          const perItem = elapsed / Math.max(1, done);
          log.info(
            `progress ${done}/${target} (${Math.round((done / target) * 100)}%) — ` +
              `ok ${counts.detailsSucceeded}, failed ${counts.detailsFailed}, ` +
              `lanes ${throttle.lanes}, elapsed ${humanDuration(elapsed)}, ` +
              `ETA ${humanDuration(perItem * (target - done))}`,
          );
        }
      }
    }

    log.info('=== STAGE 2 complete ===', {
      attempted: counts.detailsAttempted,
      succeeded: counts.detailsSucceeded,
      failed: counts.detailsFailed,
      elapsed: humanDuration(Date.now() - stageStartedAt),
    });
  }

  counts.throttleEvents = throttle.throttleEvents;
  counts.reauthEvents = throttle.reauthEvents;

  const failed = outcomes.filter((o) => o.error);
  const status: ProductSyncStatus =
    counts.departmentsFailed === 0 && counts.detailsFailed === 0
      ? 'success'
      : counts.departmentsProcessed === 0
        ? 'failed'
        : 'partial';

  if (!dryRun) {
    await repository.finishSyncRun(
      syncRunId,
      status,
      counts,
      failed.length > 0
        ? `${failed.length} department(s) failed: ${failed.map((f) => f.deptCode).join(', ')}`
        : undefined,
    );
  }

  const result: SyncOreillyProductsResult = {
    syncRunId,
    dryRun,
    status,
    counts,
    departments: outcomes,
    failed,
    warnings,
    durationMs: Date.now() - startedAt,
  };

  log.info('Catalogue sync complete', {
    status,
    ...counts,
    duration: humanDuration(result.durationMs),
  });

  return result;
}
