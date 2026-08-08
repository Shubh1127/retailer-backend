/**
 * Walk one category to the end, to learn how a crawl should terminate.
 *
 * `&page=N` pages the listing, but the dangerous unknown is what an
 * OUT-OF-RANGE page does. If it clamps and re-serves the last page, a loop
 * that stops at "zero cards" never stops — it just re-reads the same 50
 * products for ever, against a live supplier.
 *
 * Read-only, and stops itself at a hard page cap regardless of what it finds.
 *
 * Usage: npx tsx src/scripts/probeOreillyWalk.ts [deptCode] [prodGroup]
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';

import { BASE_URL, ensureSession } from '../services/oreilly.service.js';

const dept = process.argv[2] ?? '4';
const group = process.argv[3];

const listing =
  `${BASE_URL}/products/gridlist.asp?DeptCode=${dept}` +
  (group ? `&prodgroup=${group}` : '&chkpm=MALL');

/** A runaway guard, not an expectation. */
const MAX_PAGES = 12;

const session = await ensureSession();
const seen = new Set<string>();
let previousSignature = '';

for (let page = 1; page <= MAX_PAGES; page += 1) {
  const url = `${listing}&page=${page}`;
  const response = await session.client.get(url, { validateStatus: () => true });
  const $ = cheerio.load(response.data as string);

  const skus = $('.ProductBox')
    .map((_, el) => $(el).find('input[name="product_code"]').val()?.toString() ?? '')
    .get()
    .filter(Boolean);

  const signature = skus.join(',');
  const fresh = skus.filter((sku) => !seen.has(sku));
  for (const sku of skus) seen.add(sku);

  console.log(
    `page ${String(page).padStart(2)}  cards ${String(skus.length).padStart(3)}` +
      `  new ${String(fresh.length).padStart(3)}  first ${skus[0] ?? '—'}` +
      `  total seen ${seen.size}`,
  );

  if (skus.length === 0) {
    console.log('\nEmpty page — a crawl can terminate on zero cards.');
    break;
  }

  if (signature === previousSignature) {
    console.log(
      '\nIDENTICAL to the previous page — the server CLAMPS out-of-range pages.',
    );
    console.log('A crawl must stop on a repeated page, not on an empty one.');
    break;
  }

  previousSignature = signature;

  if (page === MAX_PAGES) {
    console.log('\nHit the page cap without terminating — category is larger.');
  }
}

console.log(`\ndistinct products found: ${seen.size}`);
