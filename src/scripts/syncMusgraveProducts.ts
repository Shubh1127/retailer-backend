/**
 * Synchronize Musgrave products into Supabase, category by category.
 *
 * By default only TOP-LEVEL categories are synced: a parent's product endpoint
 * aggregates its whole subtree, so one pass per top-level category covers the
 * catalogue. Where the API's reported total hits its 10,000 ceiling that
 * guarantee breaks, and the sync automatically recurses into that category's
 * children (and theirs, if they are capped too).
 *
 * Usage:
 *   npm run sync:products                        # top-level + cap fallback
 *   npm run sync:products -- --all-categories    # every category (fallback mode)
 *   npm run sync:products -- --categories 3      # first 3 seeds only (smoke run)
 *   npm run sync:products -- --category WebCat_405879
 *   npm run sync:products -- --dry-run           # fetch + parse, write nothing
 *   npm run sync:products -- --amount 200        # page size (default 36)
 *   npm run sync:products -- --max-pages 5       # cap pages per category
 *   npm run sync:products -- --cap-threshold 5000
 *
 * Needs MUSGRAVE_EMAIL / MUSGRAVE_PASSWORD, and SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY unless --dry-run.
 *
 * `--categories N` limits the SEED categories; cap recursion can still add more.
 */

import 'dotenv/config';
import { syncMusgraveProducts } from '../services/musgraveProducts.sync.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function numericFlag(name: string): number | undefined {
  const value = Number(flag(name) ?? Number.NaN);
  return Number.isFinite(value) ? value : undefined;
}

const maxCategories = numericFlag('categories');
const amount = numericFlag('amount');
const maxPagesPerCategory = numericFlag('max-pages');
const pauseMs = numericFlag('pause');
const only = flag('category');

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const capThreshold = numericFlag('cap-threshold');

const result = await syncMusgraveProducts({
  dryRun: args.includes('--dry-run'),
  allCategories: args.includes('--all-categories'),
  ...(capThreshold !== undefined ? { cappedTotalThreshold: capThreshold } : {}),
  ...(maxCategories !== undefined ? { maxCategories } : {}),
  ...(amount !== undefined ? { amount } : {}),
  ...(maxPagesPerCategory !== undefined ? { maxPagesPerCategory } : {}),
  ...(pauseMs !== undefined ? { pauseMs } : {}),
  ...(only ? { onlyCategoryIds: [only] } : {}),
});

const { counts } = result;

console.log('');
console.log('==================================================');
console.log(` Product sync ${result.dryRun ? '(dry run)' : `#${result.syncRunId}`} — ${result.status}`);
console.log('==================================================');
console.log(`  spgid              : ${result.spgid}`);
console.log(`  scope              : ${result.scope}`);
console.log(`  categories         : ${counts.categoriesProcessed}/${counts.categoriesTotal} processed`);
console.log(`  categories failed  : ${counts.categoriesFailed}`);
console.log(
  `  capped categories  : ${result.cappedCategories.length}` +
    (result.expandedFromCap > 0 ? ` (+${result.expandedFromCap} children synced as fallback)` : ''),
);
console.log(`  pages fetched      : ${counts.pagesFetched}`);
console.log(`  products seen      : ${counts.productsSeen}`);
console.log(`  inserted           : ${counts.productsInserted}`);
console.log(`  updated            : ${counts.productsUpdated}`);
console.log(`  unchanged (skipped): ${counts.productsUnchanged}`);
console.log(`  elapsed            : ${duration(result.durationMs)}`);

const busiest = [...result.categories]
  .filter((c) => !c.error)
  .sort((a, b) => b.seen - a.seen)
  .slice(0, 10);

if (busiest.length > 0) {
  console.log('');
  console.log('  Largest categories');
  for (const category of busiest) {
    console.log(
      `    ${category.name.padEnd(34).slice(0, 34)} ${String(category.seen).padStart(6)} products` +
        ` · ${String(category.pages).padStart(3)} pages · ${duration(category.durationMs)}`,
    );
  }
}

if (result.cappedCategories.length > 0) {
  console.log('');
  console.log(`  Hit the ${'10,000'}-product ceiling — children synced as fallback`);
  for (const category of result.cappedCategories) {
    console.log(
      `    ${category.name.padEnd(34).slice(0, 34)} reported ${category.total} (depth ${category.depth})`,
    );
  }
}

if (result.failed.length > 0) {
  console.log('');
  console.log(`  Failed categories (${result.failed.length})`);
  for (const category of result.failed) {
    console.log(`    ${category.categoryId} — ${category.name}`);
    console.log(`      ${category.error}`);
  }
}

if (result.warnings.length > 0) {
  console.log('');
  console.log(`  Warnings (${result.warnings.length})`);
  for (const warning of result.warnings.slice(0, 15)) console.log(`    - ${warning}`);
  if (result.warnings.length > 15) {
    console.log(`    … and ${result.warnings.length - 15} more`);
  }
}

console.log('');

if (result.status === 'failed') process.exit(1);
