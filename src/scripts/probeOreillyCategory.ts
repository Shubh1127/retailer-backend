/**
 * Can a category page be crawled with the parser we already have?
 *
 * Answers the questions a catalogue sync depends on, before any of it is
 * built:
 *
 *   1. Does `gridlist.asp?DeptCode=&prodgroup=` return product cards at all,
 *      or does it need the PWA variant / a POST / something else?
 *   2. Are they the SAME `.ProductBox` cards `searchOreilly` already parses?
 *   3. Is the listing paginated, and how is the next page addressed?
 *   4. Do the cards carry price, size and pack — or only what search gets,
 *      which needs one extra detail fetch per product?
 *
 * Read-only: two GETs, no mutations.
 *
 * Usage: npx tsx src/scripts/probeOreillyCategory.ts [deptCode] [prodGroup]
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';

import { BASE_URL, ensureSession } from '../services/oreilly.service.js';

const dept = process.argv[2] ?? '4'; // Soft Drinks
const group = process.argv[3] ?? '20'; // Cans

const session = await ensureSession();

async function probe(label: string, url: string): Promise<void> {
  console.log(`\n=== ${label} ===\n${url}`);

  const response = await session.client.get(url, { validateStatus: () => true });
  const html = response.data as string;
  const $ = cheerio.load(html);

  console.log(`status ${response.status}  bytes ${html.length}`);

  // Did we get a page at all, or the login form?
  if ($('input[name="password"]').length > 0) {
    console.log('LOGIN PAGE — the session did not carry.');
    return;
  }

  const boxes = $('.ProductBox');
  console.log(`.ProductBox elements: ${boxes.length}`);

  if (boxes.length === 0) {
    // What IS on the page, then?
    console.log('page title:', $('title').first().text().trim());
    console.log('h1:', $('h1').first().text().trim().slice(0, 120));
    return;
  }

  // The exact fields `searchOreilly` reads, on the first three cards.
  boxes.slice(0, 3).each((index, element) => {
    const box = $(element);
    const sku = box.find('input[name="product_code"]').val()?.toString() ?? '';
    const name = box.find('a[href*="DetailsPortal"]').last().text().trim();
    const price = box.find('.PromoPrice, .Price, .StdPrice').first().text().trim();
    const image =
      box.find('a[href*="DetailsPortal"] img').first().attr('src') ??
      box.find('img').first().attr('src');
    const details = box
      .find('.ProdDetails')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean);

    console.log(`\n  [${index}] sku=${sku || '(none)'}`);
    console.log(`      name  ${name.slice(0, 60) || '(none)'}`);
    console.log(`      price ${price || '(none)'}`);
    console.log(`      image ${image ?? '(none)'}`);
    console.log(`      details ${JSON.stringify(details.slice(0, 4))}`);
  });

  // Pagination: how does the next page get addressed?
  const pageLinks = $('a[href*="page="], a[href*="Page="]')
    .map((_, el) => $(el).attr('href'))
    .get()
    .filter((href): href is string => Boolean(href))
    .slice(0, 6);

  console.log(
    `\n  pagination links: ${pageLinks.length ? JSON.stringify(pageLinks) : 'none found'}`,
  );

  // A stated total tells us whether the first page is the whole category.
  const totalText = $('body')
    .text()
    .match(/(\d+)\s+(?:products?|items?|results?)/i);
  console.log(`  stated total: ${totalText ? totalText[0] : '(none found)'}`);
}

await probe(
  `Department ${dept}, group ${group}`,
  `${BASE_URL}/products/gridlist.asp?DeptCode=${dept}&prodgroup=${group}`,
);

await probe(
  `Department ${dept}, ALL products`,
  `${BASE_URL}/products/gridlist.asp?DeptCode=${dept}&chkpm=MALL`,
);
