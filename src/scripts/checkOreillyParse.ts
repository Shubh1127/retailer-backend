/**
 * What the O'Reilly parsers actually produce, from live pages.
 *
 * Prices, RRP, POR and VAT land in numeric columns, so a parse that is quietly
 * wrong stores wrong money rather than failing. This prints the parsed records
 * beside the raw text they came from, so both can be compared by eye.
 *
 * Read-only.
 *
 * Usage: npx tsx src/scripts/checkOreillyParse.ts [deptCode]
 */

import 'dotenv/config';

import { BASE_URL, ensureSession } from '../services/oreilly.service.js';
import { parseDetailPage, parseListingPage } from '../services/oreillyCrawl.parse.js';

const dept = process.argv[2] ?? '4';

const session = await ensureSession();

const listing = await session.client.get(
  `${BASE_URL}/products/gridlist.asp?DeptCode=${dept}&chkpm=MALL&page=1`,
);

const { products } = parseListingPage(listing.data as string);

console.log(`parsed ${products.length} products from the listing\n`);

for (const product of products.slice(0, 4)) {
  console.log(`${product.productCode}  ${product.name}`);
  console.log(
    `  price ${product.price} (from "${product.priceText}")` +
      `   rrp ${product.rrp} (from "${product.rrpText}")`,
  );
  console.log(
    `  porPct ${product.porPct}   vatRate ${product.vatRate} (from "${product.vatText}")`,
  );
  console.log(`  image ${product.imageUrl}`);
}

const first = products[0];
if (first?.productUrl) {
  const detail = await session.client.get(first.productUrl);
  console.log(`\nDETAIL for ${first.productCode}:`);
  console.log(JSON.stringify(parseDetailPage(detail.data as string), null, 2));
}

// Sanity checks that a wrong parse would fail loudly.
const withPrice = products.filter((p) => typeof p.price === 'number').length;
const withEanable = products.filter((p) => p.productUrl).length;
console.log(
  `\n${withPrice}/${products.length} have a numeric price, ` +
    `${withEanable}/${products.length} have a detail URL`,
);
