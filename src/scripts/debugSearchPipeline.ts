/**
 * Debug mode: show exactly what the supplier search services are sent.
 *
 * Reads an uploaded Excel/CSV order file and prints, for every product, the sheet
 * row it came from, the description as it appears in the file, the parsed product
 * object, the exact string sent to Musgrave, the exact string sent to O'Reilly,
 * and every field the pipeline extracted along the way.
 *
 * Inspection only. No supplier is searched, nothing is written to the database,
 * and the production order flow does not depend on this script.
 *
 * Usage:
 *   npm run debug:search -- --limit 10
 *   npm run debug:search -- --file test-data/061025bjd.xls
 *   npm run debug:search -- --row 42                # one Excel row
 *   npm run debug:search -- --all-rows --limit 40   # include rows that parsed to nothing
 *   npm run debug:search -- --full                  # untruncated URLs
 *   npm run debug:search -- --json                  # machine-readable
 *   npm run debug:search -- --out trace.json
 *   npm run debug:search -- --resolve-session       # log in to show the real Musgrave spgid
 *
 * Credentials are needed ONLY for --resolve-session (MUSGRAVE_EMAIL /
 * MUSGRAVE_PASSWORD). Everything else runs fully offline.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  debugSearchPipeline,
  SPGID_PLACEHOLDER,
  type RowTrace,
  type SearchPipelineDebugOptions,
} from '../services/searchPipelineDebug.service.js';
import { getMusgraveSession } from '../services/musgrave.service.js';
import { resolveTestDataFile } from './testDataFile.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

function numericFlag(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const limit = numericFlag('limit');
const onlyRow = numericFlag('row');
const defaultCases = numericFlag('default-cases');
const includeNonProductRows = has('all-rows');
const asJson = has('json');
const full = has('full');
const outPath = flag('out');

const inputPath = resolveTestDataFile(flag('file'));
const file = readFileSync(inputPath);

// Only reason to touch the network: substitute the real spgid into the URL.
let spgid: string | undefined;
if (has('resolve-session')) {
  try {
    spgid = (await getMusgraveSession()).pgid;
  } catch (error) {
    console.error(
      `Could not resolve a Musgrave session (${error instanceof Error ? error.message : String(error)}).`,
    );
    console.error(`Falling back to the ${SPGID_PLACEHOLDER} placeholder.\n`);
  }
}

const options: SearchPipelineDebugOptions = {
  includeNonProductRows,
  fileLabel: inputPath,
  ...(limit !== undefined ? { limit } : {}),
  ...(onlyRow !== undefined ? { onlyRow } : {}),
  ...(defaultCases !== undefined ? { defaultCases } : {}),
  ...(spgid ? { spgid } : {}),
};

const report = debugSearchPipeline(file, options);

if (asJson) {
  const text = JSON.stringify(report, null, 2);
  if (outPath) {
    writeFileSync(outPath, text, 'utf8');
    console.log(`Trace written to ${outPath}`);
  } else {
    console.log(text);
  }
  process.exit(0);
}

// ---- Human-readable report ------------------------------------------------

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

/** Keep long URLs from swamping the terminal unless --full is passed. */
function clip(value: string, width = 150): string {
  if (full || value.length <= width) return value;
  return `${value.slice(0, width)}… (+${value.length - width} chars, --full to see it all)`;
}

/** Quoted and escaped, so trailing spaces and tabs in the sheet are visible. */
function exact(value: string): string {
  return JSON.stringify(value);
}

function printRow(trace: RowTrace): void {
  console.log('');
  console.log(THIN);
  console.log(`EXCEL ROW ${trace.excelRow}`);
  console.log(THIN);

  console.log(`  Original description : ${exact(trace.originalDescription)}`);

  if (!trace.parsedProduct) {
    console.log(`  Parsed product       : NONE — ${trace.noProductReason}`);
    console.log('  Sent to Musgrave     : (nothing — this row is never searched)');
    console.log("  Sent to O'Reilly     : (nothing — this row is never searched)");
    return;
  }

  console.log('  Parsed product       :');
  for (const line of JSON.stringify(trace.parsedProduct, null, 2).split('\n')) {
    console.log(`    ${line}`);
  }

  console.log('');
  console.log('  Query transformation :');
  for (const stage of trace.queryStages) {
    console.log(`    ${stage.stage.padEnd(22)} ${exact(stage.value)}`);
    console.log(`    ${' '.repeat(22)} └─ ${stage.by}`);
  }

  console.log('');
  if (trace.suppliers.length === 0) {
    console.log(`  NO SEARCH ISSUED     : ${trace.noProductReason}`);
  }

  for (const supplier of trace.suppliers) {
    console.log(`  → ${supplier.supplierName} (${supplier.supplierId})`);
    console.log(`      search string sent : ${exact(supplier.searchString)}`);
    console.log(`      sent as parameter  : ${supplier.parameter}`);
    console.log(`      request            : ${supplier.method} ${supplier.endpoint}`);
    console.log(`      full URL           : ${clip(supplier.url)}`);
    const others = Object.entries(supplier.params).filter(
      ([key]) => key !== supplier.parameter,
    );
    if (others.length > 0) {
      console.log(
        `      other params       : ${clip(others.map(([k, v]) => `${k}=${v}`).join('  '), 120)}`,
      );
    }
    if (supplier.note) console.log(`      note               : ${supplier.note}`);
  }
}

/** Extracted fields block — printed separately so the supplier calls stay adjacent. */
function printExtracted(trace: RowTrace): void {
  const extracted = trace.extracted;
  const article = trace.parsedProduct;
  if (!extracted || !article) return;

  console.log('');
  console.log('  Extracted fields     :');
  const present: [string, unknown][] = [
    ['articleCode', article.articleCode],
    ['pack (raw)', extracted.packRaw ?? '(none)'],
    ['unitsPerCase', extracted.unitsPerCase ?? '(not parsed)'],
    ['unitSize', extracted.unitSize ?? '(not parsed)'],
    ['quantity (cases)', extracted.quantityCases ?? '(none)'],
    ['mainCost', extracted.mainCost ?? '(none)'],
    ['department', extracted.department ?? '(none)'],
    ['subDepartment', extracted.subDepartment ?? '(none)'],
  ];
  for (const [key, value] of present) {
    console.log(`    ${key.padEnd(20)} ${String(value)}`);
  }
  for (const { field, reason } of extracted.absent) {
    console.log(`    ${field.padEnd(20)} ${reason}`);
  }
  console.log(
    '    (none of the above is sent to either supplier — the search term is the description alone)',
  );
}

console.log(RULE);
console.log(' SEARCH PIPELINE DEBUG — what the supplier services actually receive');
console.log(RULE);
console.log(`File            : ${report.file}`);
console.log(`Store           : ${report.storeName ?? '(unknown)'}`);
console.log(`Rows in sheet   : ${report.sheetRows}`);
console.log(`Parsed products : ${report.productRows}`);
console.log(`Rows traced     : ${report.tracedRows}`);
console.log(`Musgrave spgid  : ${report.spgid}`);
console.log('');
console.log('Pipeline: sheet row → importEposListing → ShopArticle → cleanSearchQuery → supplier');
console.log('No supplier was contacted by this run.');

for (const trace of report.rows) {
  printRow(trace);
  printExtracted(trace);
}

console.log('');
console.log(RULE);
console.log(' OBSERVATIONS');
console.log(RULE);
for (const observation of report.observations) {
  console.log(`  - ${observation}`);
}

if (report.tracedRows === 0) {
  console.log('');
  console.log(
    'No rows traced. Check --row / --limit, or that the file has the EPOS "Article' +
      ' Order Listing" layout (a header row containing Article and Description).',
  );
}

if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log(`Full trace also written to ${outPath}`);
}

console.log('');
