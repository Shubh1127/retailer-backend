/**
 * O'Reilly Wholesale connector.
 *
 * Platform: Classic ASP wholesale catalogue.
 * Search results are addressable through a GET request to gridlist.asp using
 * the `product_desc` query parameter.
 *
 * Observed:
 *   Search URL : https://order.oreillyswholesale.com/products/gridlist.asp?product_desc={QUERY}
 *   Product URL: https://order.oreillyswholesale.com/products/DetailsPortal.asp?product_code={SKU}
 *   Product cards expose:
 *     - Product Code
 *     - Product Name
 *     - Size
 *     - Case Price
 *     - VAT
 *     - RRP
 *     - Stock Status
 *
 * The web fetch layer is responsible for downloading the HTML and extracting a
 * SearchCard. This connector only defines URL patterns and normalization.
 */

import {
  normalizeCard,
  type SearchCard,
  type SupplierConnector,
  type NormalizedCard,
} from "./types.js";

export const oreillyConnector: SupplierConnector = {
  supplierId: "oreilly",

  searchIsUrlAddressable: true,

  searchUrlByEan(ean: string): string {
    return `https://order.oreillyswholesale.com/products/gridlist.asp?product_desc=${encodeURIComponent(
      ean
    )}`;
  },

  searchUrlByText(query: string): string {
    return `https://order.oreillyswholesale.com/products/gridlist.asp?product_desc=${encodeURIComponent(
      query
    )}`;
  },

  productUrl(supplierSku: string): string {
    return `https://order.oreillyswholesale.com/products/DetailsPortal.asp?product_code=${encodeURIComponent(
      supplierSku
    )}`;
  },

  normalize(
    card: SearchCard,
    ctx: { unitGtin: string; capturedAt: string }
  ): NormalizedCard {
    return normalizeCard(card, {
      ...ctx,
      supplierId: "oreilly",
    });
  },
};

export const OREILLY_EXTRACT_JS = `
Array.from(document.querySelectorAll(".ProductBox")).map(el => ({
   supplierSku:
      el.querySelector("input[name='product_code']")?.value,

   name:
      el.querySelector("a[href*='DetailsPortal']")?.textContent?.trim(),

   priceText:
      el.querySelector(".StdPrice")?.textContent?.trim(),

   sizeText:
      // selector after inspecting HTML

   vatText:
      // extract VAT

   productUrl:
      el.querySelector("a[href*='DetailsPortal']")?.href,
}));
`;