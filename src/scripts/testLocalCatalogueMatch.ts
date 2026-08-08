/**
 * Validation harness: how well does the LOCAL Musgrave catalogue cover a real
 * retailer order file?
 *
 * Reads an order file from backend/test-data/, parses it with the production
 * importer, and matches every line against `musgrave_products` only — no live
 * supplier search, no writes, no involvement in the production order flow.
 *
 * Usage:
 *   npm run test:local-match
 *   npm run test:local-match -- --file test-data/week-32.xlsx
 *   npm run test:local-match -- --min 0.85      # acceptance threshold
 *   npm run test:local-match -- --limit 25      # first N lines only
 *   npm run test:local-match -- --verbose       # show runner-up candidates
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. No supplier credentials —
 * nothing here talks to Musgrave.
 */

import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { importEposListing } from '../ingest/eposListing.js';
import { resolveTestDataFile } from './testDataFile.js';
import { SupabaseMusgraveProductRepository } from '../repositories/musgraveProduct.repository.js';
import {
  buildCatalogueIndex,
  classifyLocalMatch,
  matchArticleLocally,
  type LocalMatchResult,
  type MatchAttribution,
  type MatchOutcome,
} from '../services/localCatalogueMatch.service.js';
import { DEFAULT_MIN_CONFIDENCE } from '../services/matchConfidence.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function numericFlag(name: string): number | undefined {
  const value = Number(flag(name) ?? Number.NaN);
  return Number.isFinite(value) ? value : undefined;
}

const verbose = args.includes('--verbose');
const minConfidence = numericFlag('min') ?? DEFAULT_MIN_CONFIDENCE;
const lineLimit = numericFlag('limit');

const pct = (value: number) => `${Math.round(value * 100)}%`;

const inputPath = resolveTestDataFile(flag('file'));
statSync(inputPath); // fail fast with a clear ENOENT if --file was wrong

console.log(`Order file : ${inputPath}`);

// Parse exactly as the production import does.
const parsed = importEposListing(readFileSync(inputPath));
const articles = lineLimit !== undefined ? parsed.articles.slice(0, lineLimit) : parsed.articles;

console.log(`Store      : ${parsed.storeName ?? '(unknown)'}`);
console.log(`Lines      : ${articles.length}${lineLimit !== undefined ? ` (of ${parsed.articles.length})` : ''}`);
if (parsed.skipped.length > 0) {
  console.log(`Unreadable : ${parsed.skipped.length} row(s) the importer could not parse`);
}

if (articles.length === 0) {
  console.error(
    '\nNo order lines parsed. The file needs the EPOS "Article Order Listing" layout' +
      ' (a header row containing Article and Description).',
  );
  process.exit(1);
}

// Load the local catalogue once; match everything in memory.
const repository = new SupabaseMusgraveProductRepository();
const catalogue = await repository.listCatalogue();

if (catalogue.length === 0) {
  console.error(
    '\nThe local catalogue is empty — run the product sync before measuring match quality.',
  );
  process.exit(1);
}

console.log(`Catalogue  : ${catalogue.length} products`);
console.log(`Threshold  : ${pct(minConfidence)}\n`);

const index = buildCatalogueIndex(catalogue);

const results: LocalMatchResult[] = articles.map((article) =>
  matchArticleLocally(article, index, { minConfidence }),
);

results.forEach((result, i) => {
  console.log(`Line ${i + 1}`);
  console.log(`Input: ${result.article.description}${result.article.packRaw ? `  [${result.article.packRaw}]` : ''}`);

  if (result.accepted && result.best) {
    console.log(`Matched: ${result.best.name}`);
    console.log(`Confidence: ${pct(result.best.confidence)}`);
    console.log(`SKU: ${result.best.sku}`);
  } else {
    console.log('No suitable local match');
    if (result.best) {
      // The near-miss is the actionable part — show what was rejected and why.
      console.log(
        `  closest: ${result.best.name} (${result.best.sku}) at ${pct(result.best.confidence)}`,
      );
      console.log(`  reason: ${result.best.reason}`);
    } else {
      console.log('  reason: nothing in the catalogue shared any identifying words.');
    }
  }

  if (verbose && result.ranked.length > 1) {
    console.log('  other candidates:');
    for (const candidate of result.ranked.slice(1)) {
      console.log(
        `    ${pct(candidate.confidence).padStart(4)}  ${candidate.sku.padEnd(9)} ${candidate.name}`,
      );
    }
  }

  console.log('');
});

const matched = results.filter((r) => r.accepted);
const unmatched = results.filter((r) => !r.accepted);
const needsReview = unmatched.filter((r) => r.bucket === 'needs-review');
const averageConfidence =
  matched.length > 0
    ? matched.reduce((sum, r) => sum + (r.best?.confidence ?? 0), 0) / matched.length
    : 0;

console.log('==================================================');
console.log(` Summary`);
console.log('==================================================');
console.log(`Total products: ${results.length}`);
console.log(`Matched: ${matched.length}`);
console.log(`Unmatched: ${unmatched.length}`);
console.log(`Average confidence: ${matched.length > 0 ? pct(averageConfidence) : 'n/a'}`);
console.log(`Coverage: ${pct(results.length > 0 ? matched.length / results.length : 0)}`);
console.log(`  (${needsReview.length} of the unmatched were near-misses a human would likely confirm)`);

// ---- Why the unmatched lines failed -------------------------------------
const classifications = results.map((result) => ({ result, ...classifyLocalMatch(result) }));

const byOutcome = new Map<MatchOutcome, { label: string; count: number }>();
const byAttribution = new Map<MatchAttribution, number>();

for (const entry of classifications) {
  const existing = byOutcome.get(entry.outcome);
  if (existing) existing.count++;
  else byOutcome.set(entry.outcome, { label: entry.label, count: 1 });
  byAttribution.set(entry.attribution, (byAttribution.get(entry.attribution) ?? 0) + 1);
}

const share = (n: number) => (results.length > 0 ? ` (${pct(n / results.length)})` : '');

console.log('');
console.log('==================================================');
console.log(' Unmatched breakdown');
console.log('==================================================');

const ordered = [...byOutcome.entries()]
  .filter(([outcome]) => outcome !== 'matched')
  .sort((a, b) => b[1].count - a[1].count);

if (ordered.length === 0) {
  console.log('  Everything matched.');
} else {
  for (const [, { label, count }] of ordered) {
    console.log(`  ${label.padEnd(42)} ${String(count).padStart(4)}${share(count)}`);
  }
}

console.log('');
console.log('Where the fix lies');
const ATTRIBUTION_LABELS: Record<MatchAttribution, string> = {
  matched: 'Already matched',
  catalogue: 'Catalogue (sync more products / missing fields)',
  matcher: 'Matching algorithm (tuning)',
  correct: 'Correct rejection (genuinely different product)',
};
for (const attribution of ['catalogue', 'matcher', 'correct', 'matched'] as MatchAttribution[]) {
  const count = byAttribution.get(attribution) ?? 0;
  if (count === 0) continue;
  console.log(`  ${ATTRIBUTION_LABELS[attribution].padEnd(48)} ${String(count).padStart(4)}${share(count)}`);
}

// ---- Coverage per EPOS department ---------------------------------------
// A department where nothing matched usually means that whole category is
// missing from the local catalogue, rather than a per-line matching failure.
const departments = new Map<string, { total: number; matched: number }>();
for (const result of results) {
  const name = result.article.department ?? '(no department)';
  const entry = departments.get(name) ?? { total: 0, matched: 0 };
  entry.total++;
  if (result.accepted) entry.matched++;
  departments.set(name, entry);
}

if (departments.size > 1) {
  const worst = [...departments.entries()]
    .map(([name, e]) => ({ name, ...e, missed: e.total - e.matched }))
    .filter((d) => d.missed > 0)
    .sort((a, b) => b.missed - a.missed)
    .slice(0, 12);

  if (worst.length > 0) {
    console.log('');
    console.log('Departments with unmatched lines');
    for (const department of worst) {
      const flag = department.matched === 0 ? '  <- nothing matched at all' : '';
      console.log(
        `  ${department.name.padEnd(34).slice(0, 34)} ${String(department.matched).padStart(4)}/${String(department.total).padEnd(4)} matched${flag}`,
      );
    }
  }
}

if (!verbose) {
  console.log('\nRe-run with --verbose to see the rejected candidates per line.');
}
console.log('');
