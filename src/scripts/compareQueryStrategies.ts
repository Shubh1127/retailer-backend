/**
 * A/B the query-generation stage on one real Excel file.
 *
 *   npm run compare:queries
 *   npm run compare:queries -- --limit 40 --file test-data/061025bjd.xls
 *
 * Runs EVERY article twice through `processArticle` — once with the rule-based
 * ladder and once with the Query Understanding model — and reports what moved.
 *
 * WHY BOTH ARMS RUN THE WHOLE PIPELINE
 *
 * The question is not "does the model produce nicer queries". It is "does the
 * retailer end up with more orderable lines", and only the full chain can
 * answer that: a broader query retrieves more candidates, which SBERT then
 * ranks, the rule engine judges and reconciliation gates. A line can gain
 * candidates and still fail, and a line can gain nothing and still flip — both
 * happen, and both are reported.
 *
 * SBERT, the rule engine and reconciliation are IDENTICAL in both arms. They
 * are not configured, stubbed or bypassed here; the only difference between the
 * two runs is the `queryStrategy` flag.
 *
 * FAIRNESS
 *
 * The two arms run back to back per article rather than as two separate passes,
 * so a supplier outage or a price change midway through hits both arms equally.
 * Supplier search is live, so counts are a snapshot of the catalogue at run
 * time, not a fixed fixture.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { importEposListing } from '../ingest/eposListing.js';
import {
  processArticle,
  type DashboardRow,
  type ProcessedArticle,
  type QueryStrategy,
} from '../services/dashboardPipeline.service.js';
import { checkQueryUnderstanding } from '../services/queryUnderstanding.client.js';
import { checkAiService } from '../services/aiMatch.client.js';
import { mapWithConcurrency } from '../services/supplierSearch.js';
import { resolveTestDataFile, TEST_DATA_DIR } from './testDataFile.js';

// ---- Options --------------------------------------------------------------

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function numericFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const productLimit = numericFlag('limit', 60);
const concurrency = numericFlag('concurrency', 3);
const maxDetails = numericFlag('max-details', 5);
const outPath = flag('out') ?? join(TEST_DATA_DIR, 'query-strategy-comparison.json');

/**
 * Run the MODEL arm first.
 *
 * The two arms run back to back, so whichever goes second meets a supplier that
 * has already been asked once. If the supplier throttles or drops a session,
 * the second arm is penalised systematically and the comparison silently
 * becomes a measurement of running-order. Re-running with the order reversed is
 * the only way to tell a real difference from that artefact.
 */
const reverseOrder = args.includes('--reverse');

/**
 * Measure the COMMERCIAL EQUIVALENCE stage instead of the query strategy.
 *
 * Both arms then use model queries and differ only in whether equivalence runs,
 * which is the only way to attribute a change to this stage rather than to the
 * build it happens to sit in.
 */
const equivalenceMode = args.includes('--equivalence');

/**
 * Restrict to specific Excel rows, for investigating a handful of lines.
 *
 * The empty-string guard is load-bearing: `Number('')` is 0, not NaN, so
 * without it an absent `--rows` produced the set {0}, which matches no article
 * and silently compared nothing. A filter that defaults to excluding everything
 * is worse than no filter.
 */
const onlyRows = new Set(
  (flag('rows') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map(Number)
    .filter((value) => Number.isFinite(value)),
);

// ---- Per-article outcome --------------------------------------------------

interface ArmOutcome {
  kind: 'ready' | 'attention';
  status?: string;
  reason?: string;
  codes: string[];
  candidateCount: number;
  queries: string[];
  querySource?: string;
  bestSupplier?: string;
  price?: number;
  supplierErrors: string[];
  /** What the equivalence stage decided, so a recovery can be audited. */
  equivalence: {
    supplier: string;
    resolved: boolean;
    identity?: string;
    identities?: string[];
    saving?: number;
    reason: string;
  }[];
  explanation?: string;
}

function summarise(result: ProcessedArticle): ArmOutcome {
  const row: DashboardRow = result.row;
  return {
    kind: row.kind,
    ...(row.kind === 'attention' ? { status: row.status, reason: row.reason } : {}),
    codes: row.kind === 'attention' ? row.codes : [],
    candidateCount: result.diagnostics.candidateCount,
    queries: result.diagnostics.retrieval.map((rung) => rung.query),
    ...(result.diagnostics.querySource ? { querySource: result.diagnostics.querySource } : {}),
    ...(row.kind === 'ready' ? { bestSupplier: row.bestSupplierName, price: row.price } : {}),
    supplierErrors: result.diagnostics.supplierErrors.map(
      (error) => `${error.supplier}: ${error.message.split('\n')[0]}`,
    ),
    equivalence: result.equivalence.map((resolution) => ({
      supplier: resolution.supplier,
      resolved: resolution.resolved,
      ...(resolution.identity ? { identity: resolution.identity } : {}),
      ...(resolution.identities ? { identities: resolution.identities } : {}),
      ...(resolution.saving !== undefined ? { saving: resolution.saving } : {}),
      reason: resolution.reason,
    })),
    ...(row.explanation ? { explanation: row.explanation } : {}),
  };
}

/**
 * Why is this line still failing?
 *
 * Reported as a CLASS, so the remaining failures can be counted by cause rather
 * than read one by one. The distinction that matters most is the first one:
 * a line with zero candidates failed at RETRIEVAL, which is the stage this
 * change targets. Everything below it retrieved fine and was rejected on the
 * merits by stages that were deliberately left alone.
 */
function failureClass(outcome: ArmOutcome): string {
  if (outcome.supplierErrors.length > 0) return 'supplier search failed (outage/login)';
  if (outcome.candidateCount === 0) return 'retrieval: no supplier returned any product';
  if (outcome.codes.includes('PRODUCT_IDENTITY_MISMATCH')) {
    return 'retrieved, but no candidate was the same product';
  }
  if (outcome.codes.includes('VARIANT_MISMATCH')) return 'retrieved, only a different variant';
  if (outcome.codes.includes('PACK_MISMATCH') || outcome.codes.includes('UNIT_SIZE_MISMATCH')) {
    return 'retrieved, only a different pack or unit size';
  }
  if (outcome.codes.includes('PACK_NOT_VERIFIABLE')) {
    return 'retrieved, pack size unverifiable on either side';
  }
  if (outcome.codes.includes('CONTAINER_MISMATCH')) return 'retrieved, only a different container';
  if (outcome.codes.includes('MULTIPACK_MISMATCH')) return 'retrieved, only a multipack version';
  if (outcome.codes.includes('MISSING_PRICE') || outcome.codes.includes('MISSING_SKU')) {
    return 'retrieved and matched, but the listing has no usable price or code';
  }
  if (outcome.status === 'Manual review required') {
    return 'retrieved, candidates too ambiguous to choose between';
  }
  if (outcome.status === 'Reconciliation failed') return 'retrieved, blocked at the safety gate';
  return `other: ${outcome.status ?? 'unknown'}`;
}

interface Comparison {
  row: number;
  articleCode: string;
  description: string;
  before: ArmOutcome;
  after: ArmOutcome;
  /** 'recovered' | 'lost' | 'still-failing' | 'unchanged-ready' */
  verdict: string;
  candidateDelta: number;
}

// ---- Run ------------------------------------------------------------------

const inputPath = resolveTestDataFile(flag('file'));
const parsed = importEposListing(readFileSync(inputPath));
const articles = (
  onlyRows.size > 0
    ? parsed.articles.filter((article) => onlyRows.has(article.sourceRow))
    : parsed.articles
).slice(0, productLimit);

console.log('='.repeat(74));
console.log(
  equivalenceMode
    ? ' Selection A/B — commercial equivalence OFF vs ON (model queries in both)'
    : ' Query generation A/B — rule ladder vs Query Understanding model',
);
console.log('='.repeat(74));
console.log(`Order file : ${inputPath}`);
console.log(`Store      : ${parsed.storeName ?? '(unknown)'}`);
console.log(`Products   : ${articles.length} of ${parsed.articles.length} in file`);

const sbertHealth = await checkAiService();
const modelHealth = await checkQueryUnderstanding();
console.log(`SBERT      : ${sbertHealth.reachable ? sbertHealth.status : 'UNREACHABLE'}`);
console.log(
  `QU model   : ${modelHealth.modelLoaded ? 'loaded' : 'NOT LOADED'}` +
    (modelHealth.error ? ` (${modelHealth.error})` : ''),
);

if (!modelHealth.modelLoaded) {
  console.error(
    '\nThe Query Understanding model is not loaded, so the "after" arm would ' +
      'silently fall back to the rule ladder and the comparison would be a lie.\n' +
      'Start the AI service with the trained model present, then re-run.',
  );
  process.exit(1);
}

console.log('');

const startedAt = Date.now();
let done = 0;

const comparisons = await mapWithConcurrency(articles, concurrency, async (article) => {
  // Both arms use the SAME query strategy when --equivalence is set, so the
  // only difference is the stage under test. Otherwise the arms differ by
  // query strategy, as before.
  const run = (queryStrategy: QueryStrategy, commercialEquivalence: boolean) =>
    processArticle(article, { maxDetails, queryStrategy, commercialEquivalence });

  // Back to back on the same article. Which arm goes FIRST is controllable,
  // because whichever goes second meets an already-queried supplier — see
  // `reverseOrder`.
  const armA: [QueryStrategy, boolean] = equivalenceMode
    ? ['model', false]
    : ['rules', false];
  const armB: [QueryStrategy, boolean] = equivalenceMode ? ['model', true] : ['model', false];

  let before: ArmOutcome;
  let after: ArmOutcome;
  if (reverseOrder) {
    after = summarise(await run(...armB));
    before = summarise(await run(...armA));
  } else {
    before = summarise(await run(...armA));
    after = summarise(await run(...armB));
  }

  const verdict =
    before.kind === 'attention' && after.kind === 'ready'
      ? 'recovered'
      : before.kind === 'ready' && after.kind === 'attention'
        ? 'lost'
        : before.kind === 'attention'
          ? 'still-failing'
          : 'unchanged-ready';

  done++;
  const arrow =
    verdict === 'recovered' ? '  RECOVERED' : verdict === 'lost' ? '  LOST' : '';
  console.log(
    `[${String(done).padStart(3)}/${articles.length}] row ${String(article.sourceRow).padEnd(4)} ` +
      `${article.description.slice(0, 40).padEnd(42)} ` +
      `cand ${String(before.candidateCount).padStart(3)} → ${String(after.candidateCount).padEnd(3)} ` +
      `${before.kind === 'ready' ? 'READY' : 'ATTN '} → ${after.kind === 'ready' ? 'READY' : 'ATTN '}` +
      arrow,
  );

  const comparison: Comparison = {
    row: article.sourceRow,
    articleCode: article.articleCode,
    description: article.description,
    before,
    after,
    verdict,
    candidateDelta: after.candidateCount - before.candidateCount,
  };
  return comparison;
});

const totalMs = Date.now() - startedAt;

// ---- Report ---------------------------------------------------------------

const readyBefore = comparisons.filter((c) => c.before.kind === 'ready').length;
const readyAfter = comparisons.filter((c) => c.after.kind === 'ready').length;
const attentionBefore = comparisons.length - readyBefore;
const attentionAfter = comparisons.length - readyAfter;

const candidatesBefore = comparisons.reduce((sum, c) => sum + c.before.candidateCount, 0);
const candidatesAfter = comparisons.reduce((sum, c) => sum + c.after.candidateCount, 0);

const zeroCandidateBefore = comparisons.filter((c) => c.before.candidateCount === 0).length;
const zeroCandidateAfter = comparisons.filter((c) => c.after.candidateCount === 0).length;

const recovered = comparisons.filter((c) => c.verdict === 'recovered');
const lost = comparisons.filter((c) => c.verdict === 'lost');
const stillFailing = comparisons.filter((c) => c.verdict === 'still-failing');

const remainingByReason = stillFailing.reduce<Record<string, number>>((counts, c) => {
  const reason = failureClass(c.after);
  counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}, {});

const modelUsed = comparisons.filter((c) => c.after.querySource === 'model').length;

const pct = (value: number, total: number) =>
  total > 0 ? `${((100 * value) / total).toFixed(1)}%` : '—';

console.log('');
console.log('='.repeat(74));
console.log(' Results');
console.log('='.repeat(74));
console.log(`Products compared          : ${comparisons.length}`);
console.log(`Model actually used        : ${modelUsed}/${comparisons.length} (rest fell back)`);
console.log(`Wall time                  : ${(totalMs / 1000).toFixed(0)}s`);
console.log('');
console.log(`                              before      after     delta`);
console.log(
  `Ready To Order             : ${String(readyBefore).padStart(6)}     ${String(readyAfter).padStart(6)}    ${
    readyAfter - readyBefore >= 0 ? '+' : ''
  }${readyAfter - readyBefore}   (${pct(readyBefore, comparisons.length)} → ${pct(readyAfter, comparisons.length)})`,
);
console.log(
  `Needs Attention            : ${String(attentionBefore).padStart(6)}     ${String(attentionAfter).padStart(6)}    ${
    attentionAfter - attentionBefore >= 0 ? '+' : ''
  }${attentionAfter - attentionBefore}`,
);
console.log(
  `Retrieved candidates       : ${String(candidatesBefore).padStart(6)}     ${String(candidatesAfter).padStart(6)}    ${
    candidatesAfter - candidatesBefore >= 0 ? '+' : ''
  }${candidatesAfter - candidatesBefore}`,
);
console.log(
  `Lines with ZERO candidates : ${String(zeroCandidateBefore).padStart(6)}     ${String(zeroCandidateAfter).padStart(6)}    ${
    zeroCandidateAfter - zeroCandidateBefore >= 0 ? '+' : ''
  }${zeroCandidateAfter - zeroCandidateBefore}`,
);

console.log('');
console.log(`Products RECOVERED by the model : ${recovered.length}`);
for (const item of recovered) {
  console.log(`  row ${String(item.row).padEnd(5)} ${item.description}`);
  console.log(`      before: ${item.before.queries.join(' | ') || '(none)'}  → ${item.before.candidateCount} candidates`);
  console.log(`      after : ${item.after.queries.join(' | ') || '(none)'}  → ${item.after.candidateCount} candidates`);
  console.log(`      now   : ${item.after.bestSupplier} €${item.after.price?.toFixed(2)}`);
  // The merge that produced the recovery, so it can be checked by eye rather
  // than taken on trust.
  for (const resolution of item.after.equivalence.filter((r) => r.resolved)) {
    console.log(`      merged: ${resolution.reason}`);
  }
}

if (lost.length > 0) {
  console.log('');
  console.log(`Products LOST (regressions)     : ${lost.length}`);
  for (const item of lost) {
    console.log(`  row ${String(item.row).padEnd(5)} ${item.description}`);
    console.log(`      before: ${item.before.queries.join(' | ')} → ready (${item.before.bestSupplier})`);
    console.log(`      after : ${item.after.queries.join(' | ')} → ${item.after.status}: ${item.after.reason}`);
  }
}

console.log('');
console.log(`Products STILL FAILING          : ${stillFailing.length}`);
console.log('  by reason:');
for (const [reason, count] of Object.entries(remainingByReason).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(4)}  ${reason}`);
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      file: inputPath,
      storeName: parsed.storeName,
      generatedAt: new Date().toISOString(),
      productsCompared: comparisons.length,
      productsInFile: parsed.articles.length,
      totalDurationMs: totalMs,
      summary: {
        readyToOrder: { before: readyBefore, after: readyAfter, delta: readyAfter - readyBefore },
        needsAttention: {
          before: attentionBefore,
          after: attentionAfter,
          delta: attentionAfter - attentionBefore,
        },
        retrievedCandidates: {
          before: candidatesBefore,
          after: candidatesAfter,
          delta: candidatesAfter - candidatesBefore,
        },
        linesWithZeroCandidates: {
          before: zeroCandidateBefore,
          after: zeroCandidateAfter,
          delta: zeroCandidateAfter - zeroCandidateBefore,
        },
        modelUsedOnLines: modelUsed,
      },
      recovered: recovered.map((item) => ({
        row: item.row,
        description: item.description,
        beforeQueries: item.before.queries,
        afterQueries: item.after.queries,
        beforeCandidates: item.before.candidateCount,
        afterCandidates: item.after.candidateCount,
        nowSupplier: item.after.bestSupplier,
        nowPrice: item.after.price,
        previousReason: item.before.reason,
      })),
      lost: lost.map((item) => ({
        row: item.row,
        description: item.description,
        beforeQueries: item.before.queries,
        afterQueries: item.after.queries,
        nowStatus: item.after.status,
        nowReason: item.after.reason,
      })),
      stillFailing: stillFailing.map((item) => ({
        row: item.row,
        description: item.description,
        queries: item.after.queries,
        candidates: item.after.candidateCount,
        status: item.after.status,
        reason: item.after.reason,
        codes: item.after.codes,
        failureClass: failureClass(item.after),
      })),
      remainingFailuresByReason: remainingByReason,
      comparisons,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('');
console.log(`Full comparison written to ${outPath}`);
