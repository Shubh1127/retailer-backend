/**
 * Turning O'Reilly HTML into records. No fetching, no persistence — so every
 * rule here can be exercised against a saved page.
 *
 * TWO SOURCES, TWO SHAPES
 *
 *   listing page  `.ProductBox` cards: code, name, price, RRP, POR, VAT, image
 *   detail page   EAN, pack quantity, size — none of which the listing carries
 *
 * The split is not a design choice; it is what the site exposes, and it is why
 * a complete catalogue costs one request per product on top of one per fifty.
 */

import * as cheerio from 'cheerio';

import { absoluteUrl, parseMoney, parsePercent } from '../connectors/types.js';
import { BASE_URL } from './oreilly.service.js';

/** One product as the listing page states it. */
export interface ListedProduct {
  productCode: string;
  name: string;
  productUrl?: string;
  imageUrl?: string;
  price?: number;
  priceText?: string;
  rrp?: number;
  rrpText?: string;
  porPct?: number;
  vatRate?: number;
  vatText?: string;
}

/** What the detail page adds. */
export interface ProductDetails {
  ean?: string;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: string;
  sizeText?: string;
}

/**
 * Is this the page we asked for, or something wearing a 200?
 *
 * A listing page always renders the product grid's own markup. A challenge
 * page, an error page and the login form do not — and all three arrive as 200
 * HTML, so parsing without this check silently records "no products" for pages
 * that were never read.
 */
export function isListingPage($: cheerio.CheerioAPI): boolean {
  return (
    $('.ProductBox').length > 0 ||
    // A genuinely empty category still renders the shell.
    $('#PageWrap').length > 0 ||
    $('form[action*="gridlist"]').length > 0
  );
}

/** Text of an element with nested markup removed, whitespace collapsed. */
function cellText($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>): string {
  const clone = element.clone();
  clone.find('div, input, script').remove();
  return clone.text().replace(/\s+/g, ' ').trim();
}

function money(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const value = parseMoney(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Every product card on one listing page.
 *
 * The `.ProdDetails` cells are a loose bag — code, "RRP €5.46", "POR 38.1%",
 * "VAT 23%" — in no guaranteed order, so each is found by its LABEL rather than
 * by position. A supplier reordering their template must not silently swap RRP
 * and VAT.
 */
export function parseListingPage(html: string): {
  products: ListedProduct[];
  /** SKUs in page order, for detecting a clamped (repeated) page. */
  signature: string;
} {
  const $ = cheerio.load(html);
  const products: ListedProduct[] = [];

  $('.ProductBox').each((_, element) => {
    const box = $(element);

    // Read as text, NEVER parsed as a number: codes carry leading zeros.
    const productCode =
      box.find('input[name="product_code"]').val()?.toString().trim() ?? '';
    if (!productCode) return;

    const name = box.find('a[href*="DetailsPortal"]').last().text().replace(/\s+/g, ' ').trim();
    const href = box.find('a[href*="DetailsPortal"]').first().attr('href');
    const priceText = box.find('.PromoPrice, .Price, .StdPrice').first().text().trim();

    const detailCells = box
      .find('.ProdDetails')
      .map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get();

    const labelled = (label: string): string | undefined =>
      detailCells
        .find((cell) => cell.toUpperCase().startsWith(label))
        ?.slice(label.length)
        .trim();

    const rrpText = labelled('RRP');
    const vatText = labelled('VAT');
    const porText = labelled('POR');

    const imageSrc =
      box.find('a[href*="DetailsPortal"] img').first().attr('src') ??
      box.find('img').first().attr('src');

    products.push({
      productCode,
      name,
      ...(href ? { productUrl: BASE_URL + href } : {}),
      ...(absoluteUrl(imageSrc, BASE_URL) ? { imageUrl: absoluteUrl(imageSrc, BASE_URL)! } : {}),
      ...(money(priceText) !== undefined ? { price: money(priceText)! } : {}),
      ...(priceText ? { priceText } : {}),
      ...(money(rrpText) !== undefined ? { rrp: money(rrpText)! } : {}),
      ...(rrpText ? { rrpText } : {}),
      // "38.1%" → 38.1. Stored as a percentage, not a fraction, matching how
      // the site states it and how a buyer talks about margin.
      ...(porText ? { porPct: parsePercent(porText) * 100 } : {}),
      // VAT as a FRACTION (0.23), matching `PriceQuote.vatRate` elsewhere.
      ...(vatText ? { vatRate: parsePercent(vatText) } : {}),
      ...(vatText ? { vatText } : {}),
    });
  });

  return {
    products,
    signature: products.map((product) => product.productCode).join(','),
  };
}

/**
 * The fields only the detail page carries.
 *
 * Values sit in a `li.StdCell` beside a `li.StdPrice2` label, so each is found
 * by matching the label text. Returns whatever it finds: a product with no EAN
 * is a real answer, not a failure, and must not be retried for ever.
 */
export function parseDetailPage(html: string): ProductDetails {
  const $ = cheerio.load(html);

  const valueFor = (label: string): string => {
    const cell = $('li.StdPrice2')
      .filter((_, el) => $(el).text().trim().toLowerCase() === label.toLowerCase())
      .parent()
      .find('li.StdCell')
      .first();
    return cellText($, cell);
  };

  const ean = valueFor('EAN Code');
  const packQty = Number(valueFor('Pack Qty'));
  const sizeText = valueFor('Size');

  const details: ProductDetails = {
    ...(ean ? { ean } : {}),
    ...(Number.isFinite(packQty) && packQty > 0 ? { unitsPerCase: packQty } : {}),
    ...(sizeText ? { sizeText } : {}),
  };

  // "330ml", "1.5L", "70g". Centilitres are converted to millilitres so one
  // unit of measure is used throughout, matching the search connector.
  const match = sizeText.match(/^([\d.]+)\s*(ml|cl|l|lt|ltr|g|kg)/i);
  if (match) {
    const raw = Number(match[1]);
    const rawUom = match[2]!.toLowerCase();

    if (Number.isFinite(raw)) {
      if (rawUom === 'cl') {
        details.unitSize = raw * 10;
        details.uom = 'ml';
      } else if (rawUom.startsWith('lt') || rawUom === 'l') {
        details.unitSize = raw;
        details.uom = 'l';
      } else if (rawUom === 'kg') {
        details.unitSize = raw;
        details.uom = 'kg';
      } else {
        details.unitSize = raw;
        details.uom = rawUom;
      }
    }
  }

  return details;
}

/**
 * The department and group tree, read from the menu that every authenticated
 * page renders.
 *
 * Taken from the markup rather than hardcoded: department codes are not
 * contiguous (9 is absent), and a list typed into the source would drift the
 * first time O'Reilly adds a category.
 */
export interface ParsedCategory {
  deptCode: number;
  prodGroup?: number;
  name: string;
  parentName?: string;
}

export function parseCategoryTree(html: string): ParsedCategory[] {
  const $ = cheerio.load(html);

  /**
   * Department NAMES are not in links.
   *
   * A department's only anchor is its "All Products" link, whose text is
   * literally "All Products" — the readable name sits in the mega-menu row that
   * reveals the department, as `onmouseover="ShowhideSub('2')"` with the name in
   * a child div. Reading names from links alone yields nine departments all
   * called "All Products", which is how this was wrong the first time.
   */
  const nameByDept = new Map<number, string>();

  $('[onmouseover*="ShowhideSub"], [onclick*="ShowhideSub"]').each((_, element) => {
    const handler =
      $(element).attr('onmouseover') ?? $(element).attr('onclick') ?? '';
    const match = handler.match(/ShowhideSub\(\s*['"](\d+)['"]\s*\)/i);
    if (!match) return;

    const name = $(element).find('div').first().text().replace(/\s+/g, ' ').trim();
    if (name) nameByDept.set(Number(match[1]), name);
  });

  const byKey = new Map<string, ParsedCategory>();

  $('a[href*="gridlist"]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    const linkText = $(element).text().replace(/\s+/g, ' ').trim();

    const dept = href.match(/DeptCode=(\d+)/i);
    if (!dept) return;

    const deptCode = Number(dept[1]);
    const group = href.match(/prodgroup=(\d+)/i);
    const prodGroup = group ? Number(group[1]) : undefined;

    // A link with no prodgroup addresses the whole department. Its text is
    // "All Products", so the name comes from the menu instead — and falls back
    // to the code rather than being dropped, because the crawl needs the
    // department far more than it needs a pretty label.
    const name =
      prodGroup === undefined
        ? (nameByDept.get(deptCode) ?? `Department ${deptCode}`)
        : linkText;

    if (!name) return;

    const key = `${deptCode}:${prodGroup ?? ''}`;
    if (byKey.has(key)) return;

    byKey.set(key, {
      deptCode,
      ...(prodGroup !== undefined ? { prodGroup } : {}),
      name,
      ...(prodGroup !== undefined && nameByDept.has(deptCode)
        ? { parentName: nameByDept.get(deptCode)! }
        : {}),
    });
  });

  // A department reachable only through its groups still has to be crawled.
  for (const category of [...byKey.values()]) {
    const key = `${category.deptCode}:`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      deptCode: category.deptCode,
      name: nameByDept.get(category.deptCode) ?? `Department ${category.deptCode}`,
    });
  }

  return [...byKey.values()];
}
