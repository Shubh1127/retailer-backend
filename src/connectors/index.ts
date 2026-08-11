/**
 * Connector registry. Add a supplier by dropping in a module and registering it.
 * Fetching is on-device; these provide URL patterns + card normalization.
 */

import type { SearchCard, SupplierConnector } from './types.js';
import { musgraveConnector } from './musgrave.js';
import { barryGroupConnector } from './barrygroup.js';
import { isValidGtin } from '../gtin.js';

export * from './types.js';
export * from './match.js';
export { musgraveConnector, MUSGRAVE_EXTRACT_JS } from './musgrave.js';
export { barryGroupConnector, BARRY_EXTRACT_JS } from './barrygroup.js';

export const CONNECTORS: Record<string, SupplierConnector> = {
  musgrave: musgraveConnector,
  barrygroup: barryGroupConnector,
};

export function connectorFor(supplierId: string): SupplierConnector | undefined {
  return CONNECTORS[supplierId];
}

/**
 * Where to send a HUMAN to see this product on the supplier's own site.
 *
 * Deliberately not the same thing as `SearchCard.productUrl`. Musgrave's search
 * API returns an Intershop REST resource path in `uri`:
 *
 *   musgrave-MWPIRL-Site/-;loc=en_IE;cur=EUR/categories;spgid=…/products/445808
 *
 * That is the API's address for the product, not the storefront's. Pasted into
 * a browser it does not render a product page, so every "View on supplier" link
 * for a Musgrave result was dead. The real storefront path is `/{slug}-sku{SKU}`
 * and the slug cannot be derived from anything the API returns — which is the
 * same reason `ProductMatch.productUrl` prefers a URL *observed* at discovery
 * over a constructed one.
 *
 * The EAN search URL has none of those problems. It is a real addressable GET
 * route, it is stable, and it lands on the product:
 *
 *   https://www.musgravemarketplace.ie/search/5000471700312?view=grid
 *
 * Falling back to the product name keeps the link useful when a listing has no
 * barcode; falling back to `productUrl` covers suppliers whose own product URL
 * is a genuine page (O'Reilly's is a real crawled URL, and it has no connector
 * registered here anyway).
 */
export function supplierViewUrl(
  supplierId: string,
  card: Pick<SearchCard, 'eanText' | 'name' | 'productUrl'>,
): string | undefined {
  const connector = connectorFor(supplierId);
  if (!connector || !connector.searchIsUrlAddressable) return card.productUrl;

  // Check-digit validated, not merely "looks numeric". A malformed barcode
  // builds a URL that loads a search page and finds nothing, which reads as
  // "the supplier does not stock it" — worse than falling through to the name.
  const ean = card.eanText?.trim().replace(/\s+/g, '');
  if (ean && isValidGtin(ean)) return connector.searchUrlByEan(ean);

  const name = card.name?.trim();
  if (name) return connector.searchUrlByText(name);

  return card.productUrl;
}
