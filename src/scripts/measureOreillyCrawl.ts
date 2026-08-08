/**
 * How long would an O'Reilly catalogue sync actually take?
 *
 * Measures rather than estimates, because the two candidate scopes differ by
 * roughly two orders of magnitude and the choice should not rest on a guess:
 *
 *   list-only   one request per 50 products
 *   complete    one request per 50 products PLUS one per product, for the
 *               EAN and pack size that only the detail page carries
 *
 * Walks every department's listings for real (that is the whole list-only
 * crawl, so its elapsed time IS the answer), then times a sample of detail
 * pages to price the second scope.
 *
 * Read-only. Paced, and capped per department so it cannot run away.
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';

import { BASE_URL, ensureSession } from '../services/oreilly.service.js';
import { sleep } from '../services/supplierSearch.js';

/** From the site's own menu. 9 is absent — the codes are not contiguous. */
const DEPARTMENTS = [
  { code: 2, name: 'Grocery' },
  { code: 3, name: 'Crisps & Snacks' },
  { code: 4, name: 'Soft Drinks' },
  { code: 5, name: 'Confectionery' },
  { code: 6, name: 'Household' },
  { code: 7, name: 'Cigarettes' },
  { code: 8, name: 'Seasonal' },
  { code: 10, name: 'Medicated Lines' },
  { code: 11, name: 'Dietary & Lifestyle' },
];

/** Runaway guard: 60 pages is 3,000 products in one department. */
const MAX_PAGES = 60;
/** Politeness between requests, matching the "human-paced" intent elsewhere. */
const PACE_MS = 120;

const session = await ensureSession();

const allSkus = new Set<string>();
const detailUrls: string[] = [];
let pageRequests = 0;

const started = Date.now();

for (const dept of DEPARTMENTS) {
  const listing = `${BASE_URL}/products/gridlist.asp?DeptCode=${dept.code}&chkpm=MALL`;
  let previous = '';
  let pages = 0;
  const before = allSkus.size;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await session.client.get(`${listing}&page=${page}`, {
      validateStatus: () => true,
    });
    pageRequests += 1;
    pages = page;

    const $ = cheerio.load(response.data as string);
    const boxes = $('.ProductBox');

    const skus = boxes
      .map((_, el) => $(el).find('input[name="product_code"]').val()?.toString() ?? '')
      .get()
      .filter(Boolean);

    if (skus.length === 0) break;

    const signature = skus.join(',');
    // Out-of-range pages CLAMP and re-serve the last page, so a repeat is the
    // terminator — "zero cards" never arrives.
    if (signature === previous) break;
    previous = signature;

    for (const sku of skus) allSkus.add(sku);

    boxes.each((_, el) => {
      const href = cheerio.load(el)('a[href*="DetailsPortal"]').first().attr('href');
      if (href) detailUrls.push(BASE_URL + href);
    });

    await sleep(PACE_MS);
  }

  console.log(
    `${dept.name.padEnd(20)} pages ${String(pages).padStart(3)}  ` +
      `products ${String(allSkus.size - before).padStart(5)}` +
      (pages >= MAX_PAGES ? '  (hit cap — more remain)' : ''),
  );
}

const listSeconds = (Date.now() - started) / 1000;

console.log(
  `\nLIST-ONLY CRAWL: ${allSkus.size} distinct products in ${pageRequests} ` +
    `requests, ${listSeconds.toFixed(1)}s (${(listSeconds / 60).toFixed(1)} min)`,
);

// ---- Price a detail fetch -------------------------------------------------

const SAMPLE = 10;
const sample = detailUrls.slice(0, SAMPLE);
const timings: number[] = [];

for (const url of sample) {
  const at = Date.now();
  await session.client.get(url, { validateStatus: () => true });
  timings.push(Date.now() - at);
  await sleep(PACE_MS);
}

const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
const sorted = [...timings].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)]!;

console.log(
  `\nDETAIL PAGE: ${timings.length} sampled — mean ${mean.toFixed(0)}ms, ` +
    `median ${median}ms, range ${sorted[0]}–${sorted[sorted.length - 1]}ms`,
);

const perProduct = (mean + PACE_MS) / 1000;
const completeSeconds = listSeconds + allSkus.size * perProduct;

console.log(
  `\nCOMPLETE CRAWL (sequential): ${listSeconds.toFixed(0)}s of listings + ` +
    `${allSkus.size} × ${perProduct.toFixed(2)}s = ` +
    `${(completeSeconds / 60).toFixed(0)} min (${(completeSeconds / 3600).toFixed(1)} h)`,
);

for (const lanes of [4, 8]) {
  const parallel = listSeconds + (allSkus.size * perProduct) / lanes;
  console.log(
    `  at ${lanes} concurrent detail fetches: ~${(parallel / 60).toFixed(0)} min`,
  );
}
