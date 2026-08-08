/**
 * Prepare supplier order files from an EPOS Article Order Listing.
 *
 * Writes one CSV per supplier and prints the match audit trail, so the whole
 * pipeline can be exercised against a real file without the HTTP layer or the
 * dashboard. Needs supplier credentials in the environment (see .env):
 * MUSGRAVE_EMAIL / MUSGRAVE_PASSWORD, OREILLY_EMAIL / OREILLY_PASSWORD.
 *
 * Usage:
 *   tsx src/scripts/prepareOrder.ts <epos-file.xls> [outDir] [--limit N] [--min 0.9]
 *
 * Start with `--limit 5` against a live account: each product is a search on two
 * logged-in trade sites, and the run is deliberately paced.
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSupplierOrderFiles } from '../services/orderFile.service.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const file = positional[0];
const outDir = positional[1] ?? 'out';

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (!file) {
  console.error(
    'usage: tsx src/scripts/prepareOrder.ts <epos-file.xls> [outDir] [--limit N] [--min 0.9]',
  );
  process.exit(1);
}

const limit = Number(flag('limit') ?? Number.NaN);
const min = Number(flag('min') ?? Number.NaN);

const eur = (n: number) => `€${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const result = await prepareSupplierOrderFiles(readFileSync(file), {
  ...(Number.isFinite(limit) ? { maxArticles: limit } : {}),
  ...(Number.isFinite(min) ? { minConfidence: min } : {}),
});

mkdirSync(outDir, { recursive: true });

console.log(`\nStore:      ${result.storeName ?? '(unknown)'}`);
console.log(
  `Articles:   ${result.summary.articlesProcessed} processed of ${result.summary.articlesInFile} in file` +
    (result.summary.skipped ? `  (${result.summary.skipped} unreadable rows)` : ''),
);
console.log(
  `Matched:    ${result.summary.matched}   review: ${result.summary.needsReview}   unmatched: ${result.summary.unmatched}` +
    `   (threshold ${pct(result.config.minConfidence)})`,
);

for (const error of result.supplierErrors) {
  console.log(`\n!  ${error.supplierId}: ${error.message}  (×${error.occurrences})`);
}

console.log('\nAwarded lines');
for (const row of result.matched) {
  const won = row.suppliers.find((s) => s.awarded);
  console.log(
    `  ${row.epos.description.padEnd(32).slice(0, 32)} ${String(row.epos.cases).padStart(3)} cs  ` +
      `→ ${(won?.supplierName ?? '?').padEnd(9)} ${(won?.supplierSku ?? '—').padEnd(10)} ` +
      `${eur(won?.exVatCasePrice ?? 0).padStart(8)}  conf ${pct(won?.confidence ?? 0)}` +
      (row.allocation?.divertedFromMain ? '  (diverted)' : ''),
  );
}

if (result.needsReview.length > 0) {
  console.log('\nNeeds review');
  for (const row of result.needsReview) {
    const best = row.candidates[0];
    console.log(
      `  ${row.epos.description.padEnd(32).slice(0, 32)} ${row.reason}` +
        (best ? `  [${best.supplierName} ${best.supplierSku} conf ${pct(best.confidence)}]` : ''),
    );
  }
}

if (result.unmatched.length > 0) {
  console.log('\nUnmatched');
  for (const row of result.unmatched) {
    console.log(`  ${row.epos.description.padEnd(32).slice(0, 32)} ${row.reason}`);
  }
}

console.log('\nOrder files');
for (const orderFile of result.files) {
  const path = join(outDir, orderFile.filename);
  writeFileSync(path, orderFile.csv, 'utf8');
  console.log(`  ${path}  ${orderFile.rowCount} lines, ${orderFile.totalCases} cases`);
}

const alloc = result.summary.allocation;
console.log(
  `\nGoods ${eur(alloc.totalGoodsExVat)} ex-VAT  ·  vs all-from-preferred ${eur(
    alloc.baselineAllFromMainExVat,
  )}  ·  saving ${eur(alloc.totalSavingExVat)}\n`,
);
