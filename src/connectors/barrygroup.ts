/**
 * Barry Group connector (ind.barrys.ie).
 *
 * Platform: classic server-rendered ASP site — the product list and details are
 * plain HTML tables (much easier to parse than Musgrave's SPA). Logged-in session
 * required. Zones: AMBIENT / CHILL. Cart = "Add to Basket".
 *
 * Observed (EAN 8888056705108, logged in):
 *   Search URL : https://www.ind.barrys.ie/products/list.asp   (Product Search box)
 *   Detail URL : https://ind.barrys.ie/products/details.asp?product_code={CODE}
 *   List row   : Product "KOKA POT NOODLES CHICKEN 70G" / "70g / 12" / code 47018,
 *                VAT Rate 0%, Price €16.95, Unit Cost INCL VAT €1.41, RRP €2.00, GM% 29.50%.
 *   Detail     : Product Code 47018, Description, Size 70g, Pack Qty 12, Layer 10,
 *                Pallet 110, Price €16.95, EAN 8888056705108, Outer Barcode 18888056201171.
 */

import { normalizeCard, type SearchCard, type SupplierConnector, type NormalizedCard } from './types.js';

export const barryGroupConnector: SupplierConnector = {
  supplierId: 'barrygroup',

  // Barry's search IS a GET form on list.asp, but with its own field names — the
  // observed query string carries filter fields `prodgroup`, `PLOFCode`,
  // `prodBrandCode` (category/brand dropdowns, left blank for a free-text search)
  // plus a keyword field. A bare `?search=` (our first guess) is the WRONG field
  // name, which is why it returned a blank page. Until the exact keyword field
  // name is confirmed, the reliable path is to drive the actual form via
  // searchFormJS (type + submit), which doesn't depend on the field name.
  // Product-DETAIL URLs ARE addressable (details.asp?product_code=CODE) — refresh
  // uses those.
  searchIsUrlAddressable: false,

  searchUrlByEan(ean: string): string {
    return this.searchUrlByText(ean);
  },

  searchUrlByText(query: string): string {
    // Known blank filter fields on Barry's list.asp search form + a keyword guess.
    // Replace `keyword` with the confirmed field name to make this addressable.
    return `https://www.ind.barrys.ie/products/list.asp?prodgroup=&PLOFCode=&prodBrandCode=&keyword=${encodeURIComponent(query)}`;
  },

  /**
   * Fill Barry's Product Search box and submit — replicates a real user typing,
   * regardless of the field's name. This is the primary, reliable search path.
   */
  searchFormJS(query: string): string {
    const q = JSON.stringify(query);
    return `(() => {
      // The visible free-text box (not the hidden filter selects).
      const box = document.querySelector(
        'input[placeholder*="Product Search" i], input[name*="keyword" i], input[name*="desc" i], input[name*="search" i], input[type="text"]'
      );
      if (!box) return false;
      const form = box.form;
      box.focus(); box.value = ${q};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      if (form) form.submit();
      else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      return true;
    })()`;
  },

  productUrl(supplierSku: string): string {
    return `https://ind.barrys.ie/products/details.asp?product_code=${encodeURIComponent(supplierSku)}`;
  },

  normalize(card: SearchCard, ctx: { unitGtin: string; capturedAt: string }): NormalizedCard {
    return normalizeCard(card, { ...ctx, supplierId: 'barrygroup' });
  },
};

/**
 * DOM extraction snippet reference for the on-device WebView. Barry's list.asp
 * renders each product as a table row; the details popup has a labelled table.
 * Structured pack fields (Size + Pack Qty) are preferred over the "70g / 12" text.
 */
export const BARRY_EXTRACT_JS = `
Array.from(document.querySelectorAll('tr')).filter(tr => /€[0-9]/.test(tr.textContent) && /\\d{4,}/.test(tr.textContent)).map(tr => {
  const cellText = (re) => { const m = tr.textContent.match(re); return m ? m[1].trim() : undefined; };
  return {
    supplierSku: cellText(/\\b(\\d{4,6})\\b/),           // product_code e.g. 47018
    name: cellText(/([A-Z][A-Z0-9 &'\\-]{4,})/),
    sizeText: cellText(/([0-9.]+\\s*[a-zA-Z]+\\s*\\/\\s*[0-9]+)/), // "70g / 12"
    priceText: cellText(/Price[^€]*€([0-9.,]+)/i) || cellText(/€([0-9.,]+)/),
    vatText: cellText(/VAT Rate\\s*:?\\s*([0-9.]+%)/i),
    rrpText: cellText(/RRP[^€]*€([0-9.,]+)/i),
    eanText: cellText(/EAN(?:\\s*Code)?\\s*:?\\s*([0-9]{8,14})/i), // details.asp shows it; must equal expected
  };
});
`;
