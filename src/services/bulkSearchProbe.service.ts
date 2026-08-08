/**
 * Bulk search probe — can the existing single-product search services carry a
 * whole order file?
 *
 * Runs one search per product against each supplier, in parallel with a
 * concurrency limit, and measures what happens: per-supplier success rates,
 * response-time distribution, and whether failures look like rate limiting,
 * expired sessions, or something else.
 *
 * Diagnostics only. Nothing is written to the database, and nothing here is used
 * by the production order flow.
 *
 * The searchers are injected, so the measurement logic is testable without
 * touching a supplier.
 */

import { cleanSearchQuery } from '../connectors/types.js';
import { mapWithConcurrency, sleep, type SupplierSearchHit } from './supplierSearch.js';
import { createLogger } from '../log.js';
import type { ShopArticle } from '../ingest/eposListing.js';

const log = createLogger('bulk-search-probe');

/** What a failure looks like, so the report can say whether bulk use is viable. */
export type SearchFailureKind =
  | 'rate-limit'
  | 'session'
  | 'blocked'
  | 'server'
  | 'network'
  | 'not-found'
  | 'unknown';

const FAILURE_PATTERNS: { kind: SearchFailureKind; pattern: RegExp }[] = [
  { kind: 'rate-limit', pattern: /\b429\b|too many requests|rate.?limit|throttl/i },
  { kind: 'session', pattern: /\b401\b|\b403\b|unauthor|forbidden|token|credentials|login|session/i },
  { kind: 'blocked', pattern: /captcha|challenge|radware|perfdrive|cloudflare|bot/i },
  { kind: 'server', pattern: /\b5\d{2}\b|internal server|bad gateway|service unavailable/i },
  { kind: 'network', pattern: /econn|etimedout|enotfound|socket|network|timeout|aborted/i },
  { kind: 'not-found', pattern: /\b404\b|not found/i },
];

/** Classify a failure message so the report can distinguish causes. */
export function classifySearchFailure(message: string): SearchFailureKind {
  for (const { kind, pattern } of FAILURE_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return 'unknown';
}

export interface ProbeSearcher {
  supplierId: string;
  search(query: string): Promise<SupplierSearchHit[]>;
}

export interface SupplierProbeResult {
  supplierId: string;
  ok: boolean;
  durationMs: number;
  hitCount: number;
  error?: { message: string; kind: SearchFailureKind };
}

export interface ProductProbeResult {
  index: number;
  articleCode: string;
  description: string;
  query: string;
  suppliers: SupplierProbeResult[];
  /** Raw hits per supplier, for the JSON dump. */
  hits: Record<string, SupplierSearchHit[]>;
}

export interface SupplierStats {
  supplierId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Succeeded but returned zero products — not an error, but not a result. */
  emptyResults: number;
  totalHits: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  longestFailureStreak: number;
  failuresByKind: Partial<Record<SearchFailureKind, number>>;
}

export interface BulkSearchProbeReport {
  totalProducts: number;
  concurrency: number;
  totalDurationMs: number;
  suppliers: SupplierStats[];
  /** Human-readable warnings about bulk viability. */
  issues: string[];
  results: ProductProbeResult[];
}

export interface BulkSearchProbeOptions {
  searchers: ProbeSearcher[];
  /** Products searched at once. Each product fans out to every supplier. */
  concurrency?: number;
  /** Pause before each product's searches, per worker. */
  pauseMs?: number;
  onProgress?: (done: number, total: number, result: ProductProbeResult) => void;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PAUSE_MS = 0;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[position]!;
}

function summarize(
  supplierId: string,
  results: readonly ProductProbeResult[],
): SupplierStats {
  const entries = results
    .map((r) => r.suppliers.find((s) => s.supplierId === supplierId))
    .filter((s): s is SupplierProbeResult => Boolean(s));

  const durations = entries.map((e) => e.durationMs).sort((a, b) => a - b);
  const failuresByKind: Partial<Record<SearchFailureKind, number>> = {};

  let longestFailureStreak = 0;
  let currentStreak = 0;

  for (const entry of entries) {
    if (entry.ok) {
      currentStreak = 0;
      continue;
    }
    currentStreak++;
    longestFailureStreak = Math.max(longestFailureStreak, currentStreak);
    const kind = entry.error?.kind ?? 'unknown';
    failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1;
  }

  const succeeded = entries.filter((e) => e.ok);

  return {
    supplierId,
    attempted: entries.length,
    succeeded: succeeded.length,
    failed: entries.length - succeeded.length,
    emptyResults: succeeded.filter((e) => e.hitCount === 0).length,
    totalHits: entries.reduce((sum, e) => sum + e.hitCount, 0),
    avgMs:
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0,
    p50Ms: Math.round(percentile(durations, 0.5)),
    p95Ms: Math.round(percentile(durations, 0.95)),
    maxMs: durations.length > 0 ? Math.round(durations[durations.length - 1]!) : 0,
    longestFailureStreak,
    failuresByKind,
  };
}

/** Turn the measurements into plain statements about bulk viability. */
export function detectIssues(suppliers: readonly SupplierStats[]): string[] {
  const issues: string[] = [];

  for (const supplier of suppliers) {
    if (supplier.attempted === 0) continue;

    const rateLimited = supplier.failuresByKind['rate-limit'] ?? 0;
    const sessionFailures = supplier.failuresByKind.session ?? 0;
    const blocked = supplier.failuresByKind.blocked ?? 0;

    if (rateLimited > 0) {
      issues.push(`${supplier.supplierId}: ${rateLimited} request(s) rate-limited.`);
    }
    if (sessionFailures > 0) {
      issues.push(
        `${supplier.supplierId}: ${sessionFailures} auth/session failure(s) — the session may not survive a bulk run.`,
      );
    }
    if (blocked > 0) {
      issues.push(`${supplier.supplierId}: ${blocked} request(s) hit a bot challenge.`);
    }

    const successRate = supplier.succeeded / supplier.attempted;
    if (successRate < 0.9) {
      issues.push(
        `${supplier.supplierId}: only ${Math.round(successRate * 100)}% of searches succeeded.`,
      );
    }

    if (supplier.longestFailureStreak >= 3) {
      issues.push(
        `${supplier.supplierId}: ${supplier.longestFailureStreak} consecutive failures — looks like throttling rather than bad luck.`,
      );
    }

    // A long tail relative to the median is the usual first sign of throttling.
    if (supplier.p50Ms > 0 && supplier.p95Ms > supplier.p50Ms * 3) {
      issues.push(
        `${supplier.supplierId}: response times degrade badly (p50 ${supplier.p50Ms}ms vs p95 ${supplier.p95Ms}ms).`,
      );
    }

    if (supplier.emptyResults > supplier.attempted * 0.5) {
      issues.push(
        `${supplier.supplierId}: ${supplier.emptyResults}/${supplier.attempted} searches returned no products — check the query text or the account's assortment.`,
      );
    }
  }

  return issues;
}

/** Search every product against every supplier and measure the run. */
export async function runBulkSearchProbe(
  articles: readonly ShopArticle[],
  options: BulkSearchProbeOptions,
): Promise<BulkSearchProbeReport> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const startedAt = Date.now();
  let completed = 0;

  log.info('Starting bulk search probe', {
    products: articles.length,
    suppliers: options.searchers.map((s) => s.supplierId),
    concurrency,
  });

  const results = await mapWithConcurrency(articles, concurrency, async (article, index) => {
    if (index >= concurrency && pauseMs > 0) await sleep(pauseMs);

    const query = cleanSearchQuery(article.description);

    const suppliers: SupplierProbeResult[] = [];
    const hits: Record<string, SupplierSearchHit[]> = {};

    // One product fans out to every supplier at once — that is how the real
    // comparison works, so it is what should be measured.
    await Promise.all(
      options.searchers.map(async (searcher) => {
        const searchStartedAt = Date.now();
        try {
          const found = await searcher.search(query);
          hits[searcher.supplierId] = found;
          suppliers.push({
            supplierId: searcher.supplierId,
            ok: true,
            durationMs: Date.now() - searchStartedAt,
            hitCount: found.length,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          hits[searcher.supplierId] = [];
          suppliers.push({
            supplierId: searcher.supplierId,
            ok: false,
            durationMs: Date.now() - searchStartedAt,
            hitCount: 0,
            error: { message: message.slice(0, 500), kind: classifySearchFailure(message) },
          });
        }
      }),
    );

    // Stable supplier order regardless of which resolved first.
    suppliers.sort(
      (a, b) =>
        options.searchers.findIndex((s) => s.supplierId === a.supplierId) -
        options.searchers.findIndex((s) => s.supplierId === b.supplierId),
    );

    const result: ProductProbeResult = {
      index,
      articleCode: article.articleCode,
      description: article.description,
      query,
      suppliers,
      hits,
    };

    completed++;
    options.onProgress?.(completed, articles.length, result);

    return result;
  });

  const suppliers = options.searchers.map((searcher) =>
    summarize(searcher.supplierId, results),
  );

  const report: BulkSearchProbeReport = {
    totalProducts: articles.length,
    concurrency,
    totalDurationMs: Date.now() - startedAt,
    suppliers,
    issues: detectIssues(suppliers),
    results,
  };

  log.info('Bulk search probe complete', {
    products: report.totalProducts,
    durationMs: report.totalDurationMs,
    issues: report.issues.length,
  });

  return report;
}
