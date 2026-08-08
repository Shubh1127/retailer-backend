/**
 * End-to-end integration test: Excel file → supplier searches → AI service.
 *
 * Walks a real order file through the whole chain exactly as the production flow
 * would, except that instead of matching with `pickBestMatch` it hands every
 * supplier candidate to the AI service and records the similarity ranking that
 * comes back.
 *
 * This is a DEVELOPMENT HARNESS, not production code:
 *
 *   - It modifies nothing. The Excel parser and both supplier search services are
 *     imported and used as-is; `orderFile.service.ts` is not touched and does not
 *     know this file exists.
 *   - It decides nothing. No filtering, no threshold, no winner — every candidate
 *     is written out with its score so the ranking can be judged by eye first.
 *   - It is disposable. Deleting this file (and its npm script) removes the
 *     harness completely and leaves the pipeline unchanged.
 *
 * The AI service is treated as what it is — an external HTTP service. It is
 * probed once at startup, every call is timed, and a failure is recorded against
 * that product while the run carries on.
 *
 * Usage:
 *   npm run test:sbert
 *   npm run test:sbert -- --limit 10
 *   npm run test:sbert -- --file test-data/061025bjd.xls
 *   npm run test:sbert -- --concurrency 1          # strictly sequential output
 *   npm run test:sbert -- --max-details 3          # O'Reilly detail fetches/search
 *   npm run test:sbert -- --ai-url http://127.0.0.1:8000
 *   npm run test:sbert -- --out test-data/sbert-test-results.json
 *
 * Needs MUSGRAVE_EMAIL / MUSGRAVE_PASSWORD, OREILLY_EMAIL / OREILLY_PASSWORD and
 * the AI service running. No Supabase.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { importEposListing, type ShopArticle } from '../ingest/eposListing.js';
import { cleanSearchQuery } from '../connectors/types.js';
import { searchMusgrave } from '../services/musgrave.service.js';
import { searchOreilly } from '../services/oreilly.service.js';
import { mapWithConcurrency, sleep, type SupplierSearchHit } from '../services/supplierSearch.js';
import { toExVat } from '../pricing/normalize.js';
import {
  candidateFromCard,
  judgeCandidates,
  selectFinal,
  type CandidateJudgement,
  type FinalSelection,
  type RuleCandidate,
  type RuleTarget,
} from '../services/ruleEngine.js';
import {
  reconcileSelection,
  summarizeByCode,
  toDashboardRow,
  type ReconciledSelection,
  type ReconciliationDashboardRow,
  type ReconciliationRequest,
} from '../services/productReconciliation.service.js';
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

const productLimit = numericFlag('limit', 50);
const concurrency = numericFlag('concurrency', 3);
const maxDetails = numericFlag('max-details', 5);
const pauseMs = numericFlag('pause', 0);
const aiTimeoutMs = numericFlag('timeout', 20_000);
/** Candidates shown per product in the terminal. The JSON keeps them all. */
const showTop = numericFlag('show-top', 3);
const aiBaseUrl = (flag('ai-url') ?? process.env.AI_SERVICE_URL ?? 'http://127.0.0.1:8000')
  .replace(/\/+$/, '');
const outPath = flag('out') ?? join(TEST_DATA_DIR, 'sbert-test-results.json');

const AI_MATCH_URL = `${aiBaseUrl}/match`;
const AI_HEALTH_URL = `${aiBaseUrl}/health`;

// ---- Result shapes --------------------------------------------------------

/** A supplier product as written to the results file. */
interface CandidateRecord {
  supplier: string;
  name: string;
  brand?: string;
  ean?: string;
  sku?: string;
  /** Units per case. Named `pack` in the results file for readability. */
  pack?: number;
  unitSize?: number;
  uom?: string;
  exVatCasePrice?: number;
  productUrl?: string;
}

/** One ranked candidate as the AI service reported it. */
interface RankingRecord {
  candidateIndex: number;
  /** The AI service's `score` — cosine similarity, renamed for this report. */
  similarity: number;
}

interface FailureRecord {
  stage: 'musgrave' | 'oreilly' | 'ai';
  message: string;
}

interface ProductResult {
  row: number;
  articleCode: string;
  excelProduct: {
    description: string;
    unitsPerCase?: number;
    unitSize?: number;
  };
  /** The string actually sent to both supplier search services. */
  searchQuery: string;
  supplierCandidates: CandidateRecord[];
  sbertRanking: RankingRecord[];
  /** Rule-engine verdict per candidate, in SBERT rank order. */
  ruleEngine: CandidateJudgement[];
  /** The final selection — at most one product per supplier. */
  selection: FinalSelection;
  /** The safety gate. Only `reconciliation.safe` may reach allocation. */
  reconciliation: ReconciledSelection;
  failures: FailureRecord[];
  timings: {
    musgraveMs?: number;
    oreillyMs?: number;
    aiMs?: number;
  };
}

/** The AI service's response shape. */
interface AiMatchResponse {
  rowId: number | string;
  ranking: { candidateIndex: number; score: number }[];
}

// ---- Helpers --------------------------------------------------------------

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

const ms = (value: number) => `${Math.round(value)}ms`;
const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;

const RULE = '-'.repeat(72);

/**
 * Turn a supplier hit into the record written to the results file, plus the
 * neutral shape the rule engine judges.
 *
 * Pack comes from `candidateFromCard` (which uses `packOfCard`) rather than from
 * `hit.match.caseConfig`: `normalizeCard` falls back to a 1×1 'each' pack when a
 * card states no size, and feeding that invented pack to the rule engine would
 * turn "unknown" into a confident mismatch.
 */
function toCandidate(
  supplier: string,
  hit: SupplierSearchHit,
): { record: CandidateRecord; rule: RuleCandidate } {
  const exVat = toExVat(hit.quote.rawCasePrice, hit.quote.vatRate, hit.quote.priceIsVatInclusive);
  const rule = candidateFromCard(supplier, hit.card, Number.isFinite(exVat) ? exVat : undefined);

  return {
    rule,
    record: {
      supplier,
      name: rule.name,
      ...(rule.brand ? { brand: rule.brand } : {}),
      ...(rule.ean ? { ean: rule.ean } : {}),
      ...(rule.sku ? { sku: rule.sku } : {}),
      ...(rule.unitsPerCase !== undefined ? { pack: rule.unitsPerCase } : {}),
      ...(rule.unitSize !== undefined ? { unitSize: rule.unitSize } : {}),
      ...(rule.uom ? { uom: rule.uom } : {}),
      ...(rule.exVatCasePrice !== undefined ? { exVatCasePrice: rule.exVatCasePrice } : {}),
      ...(hit.match.productUrl ? { productUrl: hit.match.productUrl } : {}),
    },
  };
}

/** Search one supplier, timing it and converting a throw into a recorded failure. */
async function searchSupplier(
  stage: 'musgrave' | 'oreilly',
  search: () => Promise<SupplierSearchHit[]>,
): Promise<{
  candidates: CandidateRecord[];
  rules: RuleCandidate[];
  durationMs: number;
  failure?: FailureRecord;
}> {
  const startedAt = Date.now();
  try {
    const hits = await search();
    const mapped = hits.map((hit) => toCandidate(stage, hit));
    return {
      candidates: mapped.map((m) => m.record),
      rules: mapped.map((m) => m.rule),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      candidates: [],
      rules: [],
      durationMs: Date.now() - startedAt,
      failure: { stage, message: errorMessage(error) },
    };
  }
}

/**
 * POST one product and its candidates to the AI service.
 *
 * The service's `score` is renamed to `similarity` here — that is the only
 * translation between the two contracts, and it lives on this side of the wire
 * so the AI service keeps its own vocabulary.
 */
async function rankWithAi(
  article: ShopArticle,
  candidates: CandidateRecord[],
): Promise<{ ranking: RankingRecord[]; durationMs: number; failure?: FailureRecord }> {
  const body = {
    rowId: article.sourceRow,
    query: {
      description: article.description,
      ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
      ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    },
    candidates: candidates.map((candidate) => ({
      supplier: candidate.supplier,
      name: candidate.name,
      ...(candidate.brand ? { brand: candidate.brand } : {}),
      ...(candidate.pack !== undefined ? { unitsPerCase: candidate.pack } : {}),
      ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
      ...(candidate.ean ? { ean: candidate.ean } : {}),
      ...(candidate.sku ? { sku: candidate.sku } : {}),
    })),
  };

  const startedAt = Date.now();
  try {
    const response = await fetch(AI_MATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(aiTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as AiMatchResponse;

    return {
      ranking: (json.ranking ?? []).map((entry) => ({
        candidateIndex: entry.candidateIndex,
        similarity: entry.score,
      })),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ranking: [],
      durationMs: Date.now() - startedAt,
      failure: { stage: 'ai', message: errorMessage(error) },
    };
  }
}

// ---- Run ------------------------------------------------------------------

const inputPath = resolveTestDataFile(flag('file'));
const parsed = importEposListing(readFileSync(inputPath));
const articles = parsed.articles.slice(0, productLimit);

console.log('==================================================');
console.log(' SBERT pipeline integration test');
console.log('==================================================');
console.log(`Order file  : ${inputPath}`);
console.log(`Store       : ${parsed.storeName ?? '(unknown)'}`);
console.log(`Products    : ${articles.length} (of ${parsed.articles.length} in file)`);
console.log(`AI service  : ${AI_MATCH_URL}`);
console.log(`Concurrency : ${concurrency}   O'Reilly detail fetches/search: ${maxDetails}`);

if (articles.length === 0) {
  console.error(
    '\nNo products parsed. The file needs the EPOS "Article Order Listing" layout' +
      ' (a header row containing Article and Description).',
  );
  process.exit(1);
}

// Probe the AI service once. A run against a service that is down is still
// useful — it exercises the supplier half — so this warns rather than exits.
try {
  const health = await fetch(AI_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
  const body = (await health.json()) as { status?: string; model?: string };
  console.log(`AI health   : ${body.status ?? health.status} (model ${body.model ?? 'unknown'})`);
} catch (error) {
  console.log('');
  console.log(`WARNING: AI service did not answer /health — ${errorMessage(error)}`);
  console.log('         Continuing; every AI request will be recorded as a failure.');
}

console.log('');

const startedAt = Date.now();
let completed = 0;

const results = await mapWithConcurrency(articles, concurrency, async (article, index) => {
  if (index > 0 && pauseMs > 0) await sleep(pauseMs);

  const query = cleanSearchQuery(article.description);
  const failures: FailureRecord[] = [];

  // Both suppliers at once, exactly as the real comparison fans out.
  const [musgrave, oreilly] = await Promise.all([
    searchSupplier('musgrave', () => searchMusgrave(query)),
    searchSupplier('oreilly', () => searchOreilly(query, { maxDetails })),
  ]);

  if (musgrave.failure) failures.push(musgrave.failure);
  if (oreilly.failure) failures.push(oreilly.failure);

  // Musgrave first, then O'Reilly — candidateIndex refers to THIS order, and the
  // results file preserves it, so an index in the ranking is resolvable later.
  const supplierCandidates = [...musgrave.candidates, ...oreilly.candidates];
  const ruleCandidates = [...musgrave.rules, ...oreilly.rules];

  // No candidates means nothing to rank; calling the AI service would be a
  // guaranteed empty answer, so skip it rather than log a false failure.
  const ai =
    supplierCandidates.length > 0
      ? await rankWithAi(article, supplierCandidates)
      : { ranking: [] as RankingRecord[], durationMs: undefined };

  if ('failure' in ai && ai.failure) failures.push(ai.failure);

  // --- Rule engine ---------------------------------------------------------
  // Runs on the SBERT ranking, in SBERT's order, and judges every candidate.
  // Nothing is filtered out — a REJECT is recorded, not dropped.
  const target: RuleTarget = {
    description: article.description,
    ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    ...(article.mainCost !== undefined ? { mainCost: article.mainCost } : {}),
  };

  // When the AI service is unavailable, fall back to neutral similarity so the
  // DETERMINISTIC stages still run — they are what decides correctness. Without
  // this the harness reports "no candidates" for every line and hides the fact
  // that the suppliers answered perfectly well. Mirrors the production pipeline.
  const rankedInputs =
    ai.ranking.length > 0
      ? ai.ranking
          .filter((entry) => ruleCandidates[entry.candidateIndex] !== undefined)
          .map((entry) => ({
            candidateIndex: entry.candidateIndex,
            candidate: ruleCandidates[entry.candidateIndex]!,
            similarity: entry.similarity,
          }))
      : ruleCandidates.map((candidate, index) => ({
          candidateIndex: index,
          candidate,
          similarity: 0,
        }));

  const judgements = judgeCandidates(target, rankedInputs);

  // Final selection: at most ONE product per supplier. The ranked list stops here.
  const selection = selectFinal(rankedInputs, judgements);

  // Safety gate. Re-verifies each selected product against the Excel line from
  // scratch — nothing from the rule engine is taken on trust. Only what comes
  // out of `reconciliation.safe` would be handed to allocation.
  const reconciliationRequest: ReconciliationRequest = {
    ...target,
    row: article.sourceRow,
    articleCode: article.articleCode,
  };
  const reconciliation = reconcileSelection(reconciliationRequest, selection.selected);

  const result: ProductResult = {
    row: article.sourceRow,
    articleCode: article.articleCode,
    excelProduct: {
      description: article.description,
      ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
      ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    },
    searchQuery: query,
    supplierCandidates,
    sbertRanking: ai.ranking,
    ruleEngine: judgements,
    selection,
    reconciliation,
    failures,
    timings: {
      musgraveMs: musgrave.durationMs,
      oreillyMs: oreilly.durationMs,
      ...(ai.durationMs !== undefined ? { aiMs: ai.durationMs } : {}),
    },
  };

  completed++;

  // Built as one string so concurrent workers cannot interleave a product's block.
  const musgraveLine = musgrave.failure
    ? `FAILED — ${musgrave.failure.message.split('\n')[0]}`
    : `${musgrave.candidates.length} candidates`;
  const oreillyLine = oreilly.failure
    ? `FAILED — ${oreilly.failure.message.split('\n')[0]}`
    : `${oreilly.candidates.length} candidates`;

  const packText =
    article.unitsPerCase !== undefined && article.unitSize !== undefined
      ? `${article.unitsPerCase} × ${article.unitSize}`
      : article.packRaw || '(no pack stated)';

  const lines: string[] = [
    RULE,
    `[${completed}/${articles.length}]  row ${article.sourceRow}`,
    '',
    'Excel:',
    `  ${article.description}`,
    `  ${packText}`,
    '',
    `Musgrave:  ${musgraveLine}`,
    `O'Reilly:  ${oreillyLine}`,
  ];

  if (supplierCandidates.length === 0) {
    lines.push('', 'SBERT:     skipped — no candidates to rank');
  } else if ('failure' in ai && ai.failure) {
    lines.push('', `SBERT:     FAILED — ${ai.failure.message.split('\n')[0]}`);
  } else {
    lines.push('', `SBERT Ranking  (${ai.ranking.length} scored, ${ms(ai.durationMs ?? 0)})`);

    // Only the leaders are printed; the results file keeps every candidate.
    for (const [position, judgement] of judgements.slice(0, showTop).entries()) {
      lines.push('');
      lines.push(`  ${position + 1}. ${judgement.candidate}  [${judgement.supplier}]`);
      lines.push(`     Similarity: ${judgement.sbertSimilarity.toFixed(4)}`);
      lines.push('');
      lines.push('     Rule Engine');
      for (const rule of judgement.rules) {
        // An unverifiable rule is neither a tick nor a cross — saying "✖" when
        // the EPOS file simply never stated a unit would be a lie about the data.
        const mark = rule.status === 'pass' ? '✔' : rule.status === 'fail' ? '✖' : '·';
        const suffix = rule.status === 'unknown' ? ' (unknown)' : '';
        lines.push(`       ${mark} ${rule.label}${suffix}`);
      }
      lines.push('');
      lines.push(`     Final Confidence: ${(judgement.finalConfidence * 100).toFixed(1)}%`);
      lines.push(`     Decision: ${judgement.decision}`);
      if (judgement.decision !== 'PASS') lines.push(`     Reason: ${judgement.reason}`);
    }

    if (judgements.length > showTop) {
      lines.push('', `  … ${judgements.length - showTop} further candidate(s) in the results file`);
    }

    lines.push('');
    lines.push('Final Selection');
    if (selection.status === 'selected') {
      for (const choice of selection.selected) {
        const price =
          choice.exVatCasePrice !== undefined ? `€${choice.exVatCasePrice.toFixed(2)}` : 'no price';
        lines.push(
          `  ✔ ${choice.supplier.padEnd(9)} ${choice.name}` +
            `  [sku ${choice.sku ?? '—'}, ${price}, ${(choice.finalConfidence * 100).toFixed(1)}%]`,
        );
      }
      if (selection.selected.length > 1) {
        lines.push('    → allocation decides which supplier gets the line, on price');
      }
    } else {
      lines.push(`  ✖ NONE — ${selection.reason}`);
    }
    for (const exclusion of selection.excluded) {
      lines.push(`  ! ${exclusion.supplier} excluded — ${exclusion.reason}`);
    }

    if (reconciliation.results.length > 0) {
      lines.push('');
      lines.push('Reconciliation  (final gate before allocation)');
      for (const result of reconciliation.results) {
        lines.push(
          `  ${result.passed ? '✅' : '❌'} ${result.supplier.padEnd(9)} ${result.allocatedProduct}`,
        );
        if (!result.passed) {
          for (const difference of result.differences.filter((d) => d.severity === 'critical')) {
            lines.push(`       [${difference.code}] ${difference.reason}`);
          }
        }
      }
      lines.push(
        `  → ${reconciliation.safe.length}/${selection.selected.length} cleared for allocation` +
          (reconciliation.blocked.length > 0
            ? `, ${reconciliation.blocked.length} BLOCKED`
            : ''),
      );
    }
  }

  lines.push('');
  console.log(lines.join('\n'));

  return result;
});

const totalDurationMs = Date.now() - startedAt;

// ---- Summary --------------------------------------------------------------

const totalCandidates = results.reduce((sum, r) => sum + r.supplierCandidates.length, 0);
const aiDurations = results
  .map((r) => r.timings.aiMs)
  .filter((value): value is number => value !== undefined);
const failedSupplierSearches = results.reduce(
  (sum, r) => sum + r.failures.filter((f) => f.stage !== 'ai').length,
  0,
);
const failedAiRequests = results.filter((r) => r.failures.some((f) => f.stage === 'ai')).length;
const productsWithNoCandidates = results.filter((r) => r.supplierCandidates.length === 0).length;
const aiCallsAttempted = aiDurations.length;

const allJudgements = results.flatMap((r) => r.ruleEngine);
const decisionCounts = {
  PASS: allJudgements.filter((j) => j.decision === 'PASS').length,
  REVIEW: allJudgements.filter((j) => j.decision === 'REVIEW').length,
  REJECT: allJudgements.filter((j) => j.decision === 'REJECT').length,
};
const productsWithAPass = results.filter((r) => r.selection.status === 'selected').length;
/** How often the rule engine overturned SBERT's top pick. */
const topRankOverturned = results.filter(
  (r) => r.ruleEngine.length > 0 && r.ruleEngine[0]!.decision === 'REJECT',
).length;
const rescuedByLowerRank = results.filter(
  (r) =>
    r.ruleEngine.length > 0 &&
    r.ruleEngine[0]!.decision === 'REJECT' &&
    r.selection.status === 'selected',
).length;

const selectionStatusCounts = results.reduce<Record<string, number>>((counts, r) => {
  counts[r.selection.status] = (counts[r.selection.status] ?? 0) + 1;
  return counts;
}, {});
const totalSelected = results.reduce((sum, r) => sum + r.selection.selected.length, 0);

const allReconciliations = results.flatMap((r) => r.reconciliation.results);
const totalSafe = results.reduce((sum, r) => sum + r.reconciliation.safe.length, 0);
const totalBlocked = results.reduce((sum, r) => sum + r.reconciliation.blocked.length, 0);
const failureCodes = summarizeByCode(allReconciliations);
/** Lines that had a selection but lost every one of them at the gate. */
const linesLostAtGate = results.filter(
  (r) => r.selection.selected.length > 0 && r.reconciliation.safe.length === 0,
).length;
const dashboardRows: ReconciliationDashboardRow[] = allReconciliations
  .filter((r) => !r.passed)
  .map(toDashboardRow);
const multiSupplier = results.filter((r) => r.selection.selected.length > 1).length;
const suppliersExcluded = results.reduce((sum, r) => sum + r.selection.excluded.length, 0);

console.log('==================================================');
console.log(' Summary');
console.log('==================================================');
console.log(`Total products processed   : ${results.length}`);
console.log(`Total supplier candidates  : ${totalCandidates}`);
console.log(
  `Average candidates/product : ${results.length > 0 ? (totalCandidates / results.length).toFixed(2) : '0'}`,
);
console.log(
  `Average AI response time   : ${
    aiCallsAttempted > 0
      ? ms(aiDurations.reduce((a, b) => a + b, 0) / aiCallsAttempted)
      : 'n/a (no AI calls made)'
  }`,
);
console.log(`Total execution time       : ${seconds(totalDurationMs)}`);
console.log(`Failed supplier searches   : ${failedSupplierSearches} (of ${results.length * 2})`);
console.log(`Failed AI requests         : ${failedAiRequests} (of ${aiCallsAttempted} attempted)`);
console.log(`Products with no candidates: ${productsWithNoCandidates}`);
console.log('');
console.log('Rule engine');
console.log(`  Candidates judged        : ${allJudgements.length}`);
console.log(
  `  PASS / REVIEW / REJECT   : ${decisionCounts.PASS} / ${decisionCounts.REVIEW} / ${decisionCounts.REJECT}`,
);
console.log(`  SBERT top pick rejected  : ${topRankOverturned}`);
console.log(`  …of which a lower-ranked candidate passed instead: ${rescuedByLowerRank}`);
console.log('');
console.log('Final selection');
console.log(`  Products with a selection: ${productsWithAPass}/${results.length}`);
console.log(`  Products selected from both suppliers: ${multiSupplier}`);
console.log(`  Total products selected  : ${totalSelected} (allocation input rows)`);
console.log(`  Suppliers excluded as ambiguous: ${suppliersExcluded}`);
console.log(
  `  Outcomes                 : ${Object.entries(selectionStatusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join('  ')}`,
);

console.log('');
console.log('Reconciliation (final safety gate)');
console.log(`  Products reconciled      : ${allReconciliations.length}`);
console.log(`  Cleared for allocation   : ${totalSafe}`);
console.log(`  BLOCKED before allocation: ${totalBlocked}`);
console.log(`  Lines losing every selection at the gate: ${linesLostAtGate}`);
if (Object.keys(failureCodes).length > 0) {
  console.log(
    `  Failure codes            : ${Object.entries(failureCodes)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `${code}=${count}`)
      .join('  ')}`,
  );
}

// The dashboard's rejection table, rendered as it would appear.
if (dashboardRows.length > 0) {
  console.log('');
  console.log('Reconciliation failures (dashboard view)');
  console.log(`  ${'Row'.padEnd(5)}${'Product'.padEnd(30)}${'Status'.padEnd(8)}Reason`);
  for (const row of dashboardRows.slice(0, 15)) {
    console.log(
      `  ${String(row.row ?? '').padEnd(5)}${row.product.slice(0, 28).padEnd(30)}${row.status.padEnd(7)} ${row.reason}`,
    );
  }
  if (dashboardRows.length > 15) {
    console.log(`  … ${dashboardRows.length - 15} more in the results file`);
  }
}

// Real failure text beats a count when diagnosing.
const sampleFailures = results.flatMap((r) => r.failures).slice(0, 5);
if (sampleFailures.length > 0) {
  console.log('');
  console.log('Sample failures');
  for (const failure of sampleFailures) {
    console.log(`  [${failure.stage}] ${failure.message.split('\n')[0]}`);
  }
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      file: inputPath,
      storeName: parsed.storeName,
      aiService: AI_MATCH_URL,
      generatedAt: new Date().toISOString(),
      summary: {
        productsProcessed: results.length,
        productsInFile: parsed.articles.length,
        totalCandidates,
        averageCandidatesPerProduct:
          results.length > 0 ? Number((totalCandidates / results.length).toFixed(2)) : 0,
        averageAiResponseMs:
          aiCallsAttempted > 0
            ? Math.round(aiDurations.reduce((a, b) => a + b, 0) / aiCallsAttempted)
            : null,
        totalDurationMs,
        failedSupplierSearches,
        failedAiRequests,
        productsWithNoCandidates,
        ruleEngine: {
          candidatesJudged: allJudgements.length,
          decisions: decisionCounts,
          productsWithAPass,
          sbertTopPickRejected: topRankOverturned,
          rescuedByLowerRank,
        },
        selection: {
          productsWithSelection: productsWithAPass,
          productsSelectedFromBothSuppliers: multiSupplier,
          totalSelected,
          suppliersExcludedAsAmbiguous: suppliersExcluded,
          outcomes: selectionStatusCounts,
        },
        reconciliation: {
          reconciled: allReconciliations.length,
          clearedForAllocation: totalSafe,
          blocked: totalBlocked,
          linesLostAtGate,
          failureCodes,
        },
      },
      /** Ready for the dashboard's rejection report / exception export. */
      reconciliationFailures: dashboardRows,
      products: results,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('');
console.log(`Full results written to ${outPath}`);
console.log('');
