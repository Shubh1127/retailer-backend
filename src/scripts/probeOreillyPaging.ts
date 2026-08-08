/**
 * How does an O'Reilly category listing page 2?
 *
 * The first page returns ~50 cards and a department reports fewer products
 * than one of its own groups, so the listing is certainly truncated. A
 * catalogue sync is only worth building if the rest is reachable.
 *
 * Looks for the mechanism rather than guessing at it: real paging controls in
 * the markup first, and only then a couple of candidate query parameters.
 *
 * Read-only.
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';

import { BASE_URL, ensureSession } from '../services/oreilly.service.js';

const session = await ensureSession();
const listing = `${BASE_URL}/products/gridlist.asp?DeptCode=4&chkpm=MALL`;

const first = await session.client.get(listing);
const $ = cheerio.load(first.data as string);

console.log(`baseline .ProductBox: ${$('.ProductBox').length}`);

// ---- 1. Anything in the markup that looks like paging --------------------

const paging = new Set<string>();

$('a').each((_, el) => {
  const href = $(el).attr('href') ?? '';
  const text = $(el).text().replace(/\s+/g, ' ').trim();
  // DetailsPortal links carry `Page=Products` as a breadcrumb and are NOT
  // paging — excluded so they stop drowning the real signal.
  if (href.includes('DetailsPortal')) return;
  if (/next|prev|»|«|\bmore\b|^\d{1,3}$/i.test(text) || /gridlist\.asp\?.*\d/i.test(href)) {
    paging.add(`${text || '(no text)'} -> ${href}`);
  }
});

console.log('\ncandidate paging anchors:');
console.log(paging.size ? [...paging].slice(0, 12).join('\n') : '  none');

$('select, input[type="hidden"]').each((_, el) => {
  const name = $(el).attr('name') ?? '';
  if (/page|offset|start|rows|show|per/i.test(name)) {
    console.log(`  control: ${$(el).prop('tagName')} name=${name} value=${$(el).attr('value') ?? ''}`);
  }
});

// Any onclick that navigates the listing.
const scripted = new Set<string>();
$('[onclick]').each((_, el) => {
  const code = $(el).attr('onclick') ?? '';
  if (/gridlist/i.test(code)) scripted.add(code.replace(/\s+/g, ' ').slice(0, 160));
});
console.log('\nscripted navigation to gridlist:');
console.log(scripted.size ? [...scripted].slice(0, 6).join('\n') : '  none');

// ---- 2. Candidate query parameters ---------------------------------------

async function count(url: string): Promise<number> {
  const res = await session.client.get(url, { validateStatus: () => true });
  return cheerio.load(res.data as string)('.ProductBox').length;
}

const firstSku = $('.ProductBox').first().find('input[name="product_code"]').val();

console.log(`\nfirst SKU on page 1: ${firstSku}`);

for (const param of ['page', 'pageno', 'offset', 'start', 'rows', 'ShowAll']) {
  const url = `${listing}&${param}=${param === 'rows' || param === 'ShowAll' ? '500' : '2'}`;
  const boxes = await count(url);
  const probe = cheerio.load((await session.client.get(url)).data as string);
  const sku = probe('.ProductBox').first().find('input[name="product_code"]').val();
  const moved = sku !== firstSku;
  console.log(
    `  ${param.padEnd(8)} -> ${String(boxes).padStart(3)} cards, first SKU ${sku}` +
      (moved ? '  <-- CHANGED' : ''),
  );
}
