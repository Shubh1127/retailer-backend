/**
 * Why does the rule engine reject every candidate on a line?
 *
 *   npm run analyse:rules -- --limit 250
 *
 * The A/B runs left 44 lines whose failure was "No candidate passed the rule
 * engine" — the largest single bucket, and the one neither better retrieval nor
 * commercial equivalence can touch. This answers the next question: WHICH rule
 * is doing the rejecting, and is it the only thing in the way.
 *
 * READ-ONLY. It runs the real pipeline and reports; it changes no behaviour and
 * nothing else imports it.
 *
 * TWO NUMBERS PER RULE, AND THE SECOND IS THE USEFUL ONE
 *
 *   failed        how often the rule failed on a line's best candidate
 *   SOLE blocker  how often it was the ONLY critical rule that failed
 *
 * A rule that fails alongside three others is a symptom; the candidate was
 * simply the wrong product. A rule that fails ALONE is the one standing between
 * the retailer and an order, and is where a fix would actually pay.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { importEposListing } from '../ingest/eposListing.js';
import { processArticle } from '../services/dashboardPipeline.service.js';
import { checkQueryUnderstanding } from '../services/queryUnderstanding.client.js';
import { mapWithConcurrency } from '../services/supplierSearch.js';
import type { CandidateJudgement, RuleOutcome } from '../services/ruleEngine.js';
import { resolveTestDataFile, TEST_DATA_DIR } from './testDataFile.js';

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

const productLimit = numericFlag('limit', 250);
const concurrency = numericFlag('concurrency', 3);
const maxDetails = numericFlag('max-details', 5);
const outPath = flag('out') ?? join(TEST_DATA_DIR, 'rule-failure-analysis.json');

/** The line's most promising candidate — the one that came closest to passing. */
function bestJudgement(judgements: readonly CandidateJudgement[]): CandidateJudgement | undefined {
  if (judgements.length === 0) return undefined;
  return [...judgements].sort(
    (a, b) => b.finalConfidence - a.finalConfidence || b.sbertSimilarity - a.sbertSimilarity,
  )[0];
}

function criticalFailures(judgement: CandidateJudgement): RuleOutcome[] {
  return judgement.rules.filter((rule) => rule.status === 'fail' && rule.critical);
}

interface LineAnalysis {
  row: number;
  description: string;
  candidateCount: number;
  status: string;
  reason: string;
  bestCandidate?: string;
  bestConfidence?: number;
  failedRules: { id: string; label: string; detail: string }[];
  soleBlocker?: string;
  /** Rules that could not be evaluated because one side stated nothing. */
  unknownRules: string[];
}

const inputPath = resolveTestDataFile(flag('file'));
const parsed = importEposListing(readFileSync(inputPath));
const articles = parsed.articles.slice(0, productLimit);

console.log('='.repeat(74));
console.log(' Rule-engine rejection analysis');
console.log('='.repeat(74));
console.log(`Order file : ${inputPath}`);
console.log(`Products   : ${articles.length}`);

const health = await checkQueryUnderstanding();
console.log(`QU model   : ${health.modelLoaded ? 'loaded' : 'NOT LOADED'}`);
if (!health.modelLoaded) {
  console.error('\nStart the AI service with the trained model — otherwise this analyses a different pipeline.');
  process.exit(1);
}
console.log('');

let done = 0;
const analyses = await mapWithConcurrency(articles, concurrency, async (article) => {
  const result = await processArticle(article, {
    maxDetails,
    queryStrategy: 'model',
    commercialEquivalence: true,
  });

  done++;
  if (done % 25 === 0) console.log(`  …${done}/${articles.length}`);

  if (result.row.kind !== 'attention') return undefined;

  const best = bestJudgement(result.judgements);
  const failures = best ? criticalFailures(best) : [];

  const analysis: LineAnalysis = {
    row: article.sourceRow,
    description: article.description,
    candidateCount: result.diagnostics.candidateCount,
    status: result.row.status,
    reason: result.row.reason,
    ...(best ? { bestCandidate: best.candidate, bestConfidence: best.finalConfidence } : {}),
    failedRules: failures.map((rule) => ({
      id: rule.id,
      label: rule.label,
      detail: rule.detail ?? '',
    })),
    ...(failures.length === 1 ? { soleBlocker: failures[0]!.id } : {}),
    unknownRules: (best?.rules ?? [])
      .filter((rule) => rule.status === 'unknown')
      .map((rule) => rule.id),
  };
  return analysis;
});

const failing = analyses.filter((entry): entry is LineAnalysis => entry !== undefined);

// The bucket this analysis exists for: every candidate judged, none accepted.
const noPass = failing.filter((entry) => entry.reason.includes('No candidate passed the rule engine'));

const failedCount = new Map<string, number>();
const soleCount = new Map<string, number>();
const unknownCount = new Map<string, number>();
const labels = new Map<string, string>();
const examples = new Map<string, LineAnalysis[]>();

for (const entry of noPass) {
  for (const rule of entry.failedRules) {
    failedCount.set(rule.id, (failedCount.get(rule.id) ?? 0) + 1);
    labels.set(rule.id, rule.label);
  }
  for (const id of entry.unknownRules) {
    unknownCount.set(id, (unknownCount.get(id) ?? 0) + 1);
  }
  if (entry.soleBlocker) {
    soleCount.set(entry.soleBlocker, (soleCount.get(entry.soleBlocker) ?? 0) + 1);
    const bucket = examples.get(entry.soleBlocker) ?? [];
    bucket.push(entry);
    examples.set(entry.soleBlocker, bucket);
  }
}

const ranked = [...new Set([...failedCount.keys(), ...soleCount.keys()])].sort(
  (a, b) => (soleCount.get(b) ?? 0) - (soleCount.get(a) ?? 0) || (failedCount.get(b) ?? 0) - (failedCount.get(a) ?? 0),
);

console.log('');
console.log('='.repeat(74));
console.log(` Lines where NO candidate passed the rule engine: ${noPass.length}`);
console.log('='.repeat(74));
console.log('');
console.log(`  ${'rule'.padEnd(18)}${'failed'.padStart(8)}${'SOLE blocker'.padStart(14)}   label`);
for (const id of ranked) {
  console.log(
    `  ${id.padEnd(18)}${String(failedCount.get(id) ?? 0).padStart(8)}` +
      `${String(soleCount.get(id) ?? 0).padStart(14)}   ${labels.get(id) ?? ''}`,
  );
}

const multiFailure = noPass.filter((entry) => entry.failedRules.length > 1).length;
const noFailure = noPass.filter((entry) => entry.failedRules.length === 0).length;

console.log('');
console.log(`  lines blocked by exactly one critical rule : ${noPass.length - multiFailure - noFailure}`);
console.log(`  lines failing several critical rules       : ${multiFailure}  (wrong product, not a rule problem)`);
console.log(`  lines with NO failed critical rule         : ${noFailure}  (rejected on confidence alone)`);

console.log('');
console.log('Sole-blocker examples — a fix here converts the line directly');
for (const id of ranked) {
  const bucket = examples.get(id) ?? [];
  if (bucket.length === 0) continue;
  console.log('');
  console.log(`  ${id}  (${bucket.length} line(s))`);
  for (const entry of bucket.slice(0, 4)) {
    console.log(`    row ${String(entry.row).padEnd(5)} ${entry.description.slice(0, 38).padEnd(40)}`);
    console.log(`        best: ${entry.bestCandidate?.slice(0, 56)}`);
    console.log(`        why : ${entry.failedRules[0]?.detail.slice(0, 96)}`);
  }
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      file: inputPath,
      generatedAt: new Date().toISOString(),
      productsAnalysed: articles.length,
      failingLines: failing.length,
      noPassLines: noPass.length,
      byRule: ranked.map((id) => ({
        id,
        label: labels.get(id) ?? '',
        failed: failedCount.get(id) ?? 0,
        soleBlocker: soleCount.get(id) ?? 0,
        unknown: unknownCount.get(id) ?? 0,
      })),
      shape: {
        singleCriticalRule: noPass.length - multiFailure - noFailure,
        severalCriticalRules: multiFailure,
        noCriticalRuleFailed: noFailure,
      },
      lines: noPass,
      allFailingLines: failing,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('');
console.log(`Full analysis written to ${outPath}`);
