/**
 * Musgrave Marketplace connector.
 *
 * Platform: Intershop Commerce (x-icm-channel) behind Radware Bot Manager
 * (__uzm* cookies); prices are login-gated. So fetching runs on-device in the
 * logged-in WebView; this connector provides the URL patterns and normalizes the
 * search-card fields the WebView extracts.
 *
 * Observed (searching EAN 8888056705108 while logged in):
 *   Search URL : https://www.musgravemarketplace.ie/search/{EAN}?view=grid
 *   Product URL: https://www.musgravemarketplace.ie/{slug}-sku{SKU}
 *   Card fields: NAME, SKU (e.g. 531505), SIZE ("12 x 70 g"), PRICE ("€16.99"),
 *                RRP, POR, VAT ("0.0%"), UCIV (unit cost inc VAT).
 */

import { normalizeCard, type SearchCard, type SupplierConnector, type NormalizedCard } from './types.js';

export const musgraveConnector: SupplierConnector = {
  supplierId: 'musgrave',

  // Musgrave search is an addressable GET route: /search/{query}?view=grid.
  // Navigating to it is identical to a human typing + Enter (confirmed: the
  // shared screenshot's address bar was exactly this URL).
  searchIsUrlAddressable: true,

  searchUrlByEan(ean: string): string {
    return `https://www.musgravemarketplace.ie/search/${encodeURIComponent(ean)}?view=grid`;
  },

  searchUrlByText(query: string): string {
    return `https://www.musgravemarketplace.ie/search/${encodeURIComponent(query)}?view=grid`;
  },

  productUrl(supplierSku: string): string {
    // Product pages are `/{slug}-sku{SKU}`; the slug isn't needed to resolve —
    // Musgrave redirects `-sku{SKU}` to the canonical page.
    return `https://www.musgravemarketplace.ie/-sku${encodeURIComponent(supplierSku)}`;
  },

  normalize(card: SearchCard, ctx: { unitGtin: string; capturedAt: string }): NormalizedCard {
    return normalizeCard(card, { ...ctx, supplierId: 'musgrave' });
  },
};

/**
 * DOM extraction snippet reference (runs in the on-device WebView on a search
 * results page). Returns SearchCard[] for the connector to normalize. Kept as a
 * string spec here; the iOS connector bundle injects the equivalent JS.
 */
/**
 * Category-page HARVEST spec (runs in the on-device WebView / extension while
 * paging through Browse Products → a category). Reads every product tile on a
 * listing page and returns Name/Size/SKU/EAN rows — the mapping goldmine, in
 * bulk, one page load per ~36 products (vs one search per product). Page through
 * the category, gently, to build the shared map.
 */
export const MUSGRAVE_CATEGORY_HARVEST_JS = `
Array.from(document.querySelectorAll('[data-testid="product-tile"], .product-tile, .product')).map(el => {
  const t = el.textContent || '';
  const pick = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
  const a = el.querySelector('a[href*="-sku"]');
  return {
    name: (el.querySelector('.product-title, h3, a[href*="-sku"]')?.textContent || '').trim(),
    size: pick(/SIZE:?\\s*([0-9][^\\n]{0,24})/i),
    sku: pick(/SKU:?\\s*([0-9]+)/i),
    ean: pick(/EAN(?:\\s*CODE)?:?\\s*([0-9]{8,14})/i),
    productUrl: a ? a.href : null,
  };
}).filter(r => r.sku && r.ean);
`;

export const MUSGRAVE_EXTRACT_JS = `
Array.from(document.querySelectorAll('[data-testid="product-tile"], .product-tile, .product')).map(el => {
  const t = (sel) => (el.querySelector(sel)?.textContent || '').trim();
  const label = (re) => {
    const m = el.textContent.match(re); return m ? m[1].trim() : undefined;
  };
  return {
    supplierSku: label(/SKU:?\\s*([0-9]+)/i),
    name: t('.product-title, .name, h3, a[href*="-sku"]'),
    sizeText: label(/SIZE:?\\s*([0-9]+\\s*[x×][^\\n<]+)/i),
    priceText: t('.price, .product-price') || label(/€\\s*[0-9.,]+/),
    rrpText: label(/RRP:?\\s*(€?[0-9.,]+)/i),
    vatText: label(/VAT:?\\s*([0-9.]+%)/i),
    eanText: label(/EAN(?:\\s*CODE)?:?\\s*([0-9]{8,14})/i), // must equal the expected EAN
    productUrl: el.querySelector('a[href*="-sku"]')?.href,
  };
});
`;
