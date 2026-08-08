/**
 * Proof of concept: can the existing single-product search services carry a
 * whole order file?
 *
 * Reads an order file from backend/test-data/, parses it with the production
 * importer, then runs one Musgrave search and one O'Reilly search per product,
 * in parallel with a concurrency limit. Everything is held in memory and dumped
 * to JSON — nothing is written to the database and nothing here is used by the
 * production order flow.
 *
 * Usage:
 *   npm run poc:bulk-search
 *   npm run poc:bulk-search -- --limit 20          # first N products
 *   npm run poc:bulk-search -- --concurrency 6
 *   npm run poc:bulk-search -- --max-details 3     # O'Reilly detail fetches/search
 *   npm run poc:bulk-search -- --pause 200         # throttle between products
 *   npm run poc:bulk-search -- --out results.json
 *   npm run poc:bulk-search -- --file test-data/week-32.xlsx
 *
 * Needs MUSGRAVE_EMAIL / MUSGRAVE_PASSWORD and OREILLY_EMAIL / OREILLY_PASSWORD.
 * No Supabase.
 *
 * Start small (`--limit 10`): each product is two live searches against logged-in
 * trade accounts, and O'Reilly additionally fetches a detail page per candidate.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importEposListing } from '../ingest/eposListing.js';
import { searchMusgrave } from '../services/musgrave.service.js';
import { searchOreilly } from '../services/oreilly.service.js';
import {
  runBulkSearchProbe,
  type ProbeSearcher,
  type SearchFailureKind,
} from '../services/bulkSearchProbe.service.js';
import { resolveTestDataFile, TEST_DATA_DIR } from './testDataFile.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function numericFlag(name: string): number | undefined {
  const value = Number(flag(name) ?? Number.NaN);
  return Number.isFinite(value) ? value : undefined;
}

const productLimit = numericFlag('limit');
const concurrency = numericFlag('concurrency') ?? 4;
const maxDetails = numericFlag('max-details') ?? 5;
const pauseMs = numericFlag('pause') ?? 0;
const outPath = flag('out') ?? join(TEST_DATA_DIR, 'bulk-search-results.json');

const ms = (value: number) => `${Math.round(value)}ms`;
const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;

const inputPath = resolveTestDataFile(flag('file'));

const parsed = importEposListing(readFileSync(inputPath));
const articles =
  productLimit !== undefined ? parsed.articles.slice(0, productLimit) : parsed.articles;

console.log(`Order file  : ${inputPath}`);
console.log(`Store       : ${parsed.storeName ?? '(unknown)'}`);
console.log(
  `Products    : ${articles.length}${productLimit !== undefined ? ` (of ${parsed.articles.length})` : ''}`,
);
console.log(`Concurrency : ${concurrency}   O'Reilly detail fetches/search: ${maxDetails}`);

if (articles.length === 0) {
  console.error(
    '\nNo products parsed. The file needs the EPOS "Article Order Listing" layout' +
      ' (a header row containing Article and Description).',
  );
  process.exit(1);
}

console.log(`\nRunning ${articles.length * 2} searches…\n`);

const searchers: ProbeSearcher[] = [
  { supplierId: 'musgrave', search: (query) => searchMusgrave(query) },
  { supplierId: 'oreilly', search: (query) => searchOreilly(query, { maxDetails }) },
];

const report = await runBulkSearchProbe(articles, {
  searchers,
  concurrency,
  pauseMs,
  onProgress(done, total, result) {
    const summary = result.suppliers
      .map((s) => `${s.supplierId}=${s.ok ? `${s.hitCount} hits` : `FAIL(${s.error?.kind})`}`)
      .join('  ');
    console.log(
      `  [${String(done).padStart(3)}/${total}] ${result.description.padEnd(32).slice(0, 32)}  ${summary}`,
    );
  },
});

// ---- Report --------------------------------------------------------------
console.log('');
console.log('==================================================');
console.log(' Bulk search feasibility');
console.log('==================================================');
console.log(`Total products in file : ${parsed.articles.length}`);
console.log(`Products searched      : ${report.totalProducts}`);
console.log(`Total searches issued  : ${report.totalProducts * searchers.length}`);
console.log(`Total execution time   : ${seconds(report.totalDurationMs)}`);
console.log(
  `Throughput             : ${(report.totalProducts / (report.totalDurationMs / 1000)).toFixed(2)} products/sec`,
);

for (const supplier of report.suppliers) {
  console.log('');
  console.log(`${supplier.supplierId}`);
  console.log(`  successful searches : ${supplier.succeeded}/${supplier.attempted}`);
  console.log(`  failed searches     : ${supplier.failed}`);
  console.log(`  returned no results : ${supplier.emptyResults}`);
  console.log(`  total hits          : ${supplier.totalHits}`);
  console.log(
    `  response time       : avg ${ms(supplier.avgMs)}  p50 ${ms(supplier.p50Ms)}  p95 ${ms(supplier.p95Ms)}  max ${ms(supplier.maxMs)}`,
  );
  const kinds = Object.entries(supplier.failuresByKind) as [SearchFailureKind, number][];
  if (kinds.length > 0) {
    console.log(
      `  failure kinds       : ${kinds.map(([kind, count]) => `${kind}=${count}`).join('  ')}`,
    );
  }
}

console.log('');
console.log('Rate-limit / session issues');
if (report.issues.length === 0) {
  console.log('  none detected');
} else {
  for (const issue of report.issues) console.log(`  - ${issue}`);
}

// A sample of real failure messages beats a category count when diagnosing.
const failureMessages = report.results
  .flatMap((r) => r.suppliers)
  .filter((s) => !s.ok && s.error)
  .slice(0, 5);

if (failureMessages.length > 0) {
  console.log('');
  console.log('Sample failures');
  for (const failure of failureMessages) {
    console.log(`  [${failure.supplierId}/${failure.error!.kind}] ${failure.error!.message}`);
  }
}

writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log('');
console.log(`Raw results written to ${outPath}`);
console.log('');

// Non-zero exit when the run says bulk use is not currently viable.
if (report.issues.length > 0) process.exit(1);
