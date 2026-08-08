/**
 * Synchronize the O'Reilly catalogue into Supabase.
 *
 * One resumable command, two stages. Listings are crawled and written first, so
 * a usable catalogue with prices exists within minutes; detail pages then fill
 * in EAN, pack quantity and size, updating each product as it completes.
 *
 * RESUMABLE. Interrupt it at any point and run it again: listings upsert by
 * product code, and enrichment picks up whatever still has no detail page read.
 * Nothing is re-fetched that has already been stored.
 *
 * Usage:
 *   npm run sync:oreilly                       # full sync, both stages
 *   npm run sync:oreilly -- --resume           # enrichment only (skip listings)
 *   npm run sync:oreilly -- --listings-only    # stage 1 only, ~4 minutes
 *   npm run sync:oreilly -- --dept 4           # one department
 *   npm run sync:oreilly -- --departments 2    # first 2 departments (smoke run)
 *   npm run sync:oreilly -- --details 100      # enrich at most 100 products
 *   npm run sync:oreilly -- --concurrency 1    # slower and gentler
 *   npm run sync:oreilly -- --dry-run          # fetch + parse, write nothing
 *
 * Needs OREILLY_EMAIL / OREILLY_PASSWORD, and SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY unless --dry-run.
 */

import 'dotenv/config';
import { syncOreillyProducts } from '../services/oreillyProducts.sync.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function numericFlag(name: string): number | undefined {
  const value = Number(flag(name) ?? Number.NaN);
  return Number.isFinite(value) ? value : undefined;
}

const dept = numericFlag('dept');
const maxDepartments = numericFlag('departments');
const maxDetails = numericFlag('details');
const detailConcurrency = numericFlag('concurrency');
const maxPagesPerDepartment = numericFlag('max-pages');
const pagePauseMs = numericFlag('pause');

const result = await syncOreillyProducts({
  ...(dept !== undefined ? { onlyDeptCodes: [dept] } : {}),
  ...(maxDepartments !== undefined ? { maxDepartments } : {}),
  ...(maxDetails !== undefined ? { maxDetails } : {}),
  ...(detailConcurrency !== undefined ? { detailConcurrency } : {}),
  ...(maxPagesPerDepartment !== undefined ? { maxPagesPerDepartment } : {}),
  ...(pagePauseMs !== undefined ? { pagePauseMs } : {}),
  skipDetails: args.includes('--listings-only'),
  skipListings: args.includes('--resume'),
  dryRun: args.includes('--dry-run'),
});

console.log('\n──────────────── O\'Reilly catalogue sync ────────────────');
console.log(`status              ${result.status}`);
console.log(`sync run            ${result.syncRunId}`);
console.log(`departments         ${result.counts.departmentsProcessed}/${result.counts.departmentsTotal} (${result.counts.departmentsFailed} failed)`);
console.log(`listing pages       ${result.counts.pagesFetched}`);
console.log(`products seen       ${result.counts.productsSeen}`);
console.log(`  inserted          ${result.counts.productsInserted}`);
console.log(`  updated           ${result.counts.productsUpdated}`);
console.log(`  unchanged         ${result.counts.productsUnchanged}`);
console.log(`detail pages        ${result.counts.detailsSucceeded}/${result.counts.detailsAttempted} (${result.counts.detailsFailed} failed)`);
console.log(`throttle events     ${result.counts.throttleEvents}`);
console.log(`re-authentications  ${result.counts.reauthEvents}`);
console.log(`duration            ${Math.round(result.durationMs / 1000)}s`);

if (result.failed.length > 0) {
  console.log('\nFailed departments:');
  for (const department of result.failed) {
    console.log(`  ${department.deptCode} ${department.name} — ${department.error}`);
  }
}

if (result.warnings.length > 0) {
  console.log(`\nWarnings (${result.warnings.length}):`);
  for (const warning of result.warnings.slice(0, 20)) console.log(`  ${warning}`);
}

// A partial run is not a success, and a scheduler should be able to tell.
process.exit(result.status === 'failed' ? 1 : 0);
