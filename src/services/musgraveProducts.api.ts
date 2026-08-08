/**
 * Musgrave Product API — fetching only.
 *
 * One page of one category. Pagination policy lives in the sync service; this
 * module just issues the request the website issues, through the existing
 * authenticated client (which supplies the dynamic spgid).
 *
 *   GET /categories;spgid={SPGID}/{categoryPath}/products
 *       ?amount=36&offset=0&sortKey=Position&returnSortKeys=true
 *       &productFilter=fallback_searchquerydefinition&attrs=…
 *
 * `categoryPath` is the FULL ancestor chain, root first — e.g.
 * "RetailWebHierarchy/WebCat_405879". The leaf id alone returns
 * "404 Category not found"; the API addresses categories by their whole path,
 * which is exactly what `categoryPath[]` (and so musgrave_category_paths) holds.
 */

import { musgraveApiGet, type MusgraveApiResponse } from './musgrave.service.js';
import { createLogger } from '../log.js';

const log = createLogger('musgrave:products:api');

/** Product attributes requested, exactly as the website asks for them. */
export const MUSGRAVE_PRODUCT_ATTRS = [
  'sku',
  'salePrice',
  'listPrice',
  'availability',
  'manufacturer',
  'image',
  'minOrderQuantity',
  'inStock',
  'promotions',
  'packingUnit',
  'productMasterSKU',
  'estimatedDeliveryDate',
  'supplier',
  'taxRate',
  'size',
  'pricePerKilo',
  'listPricePerKilo',
  'isPromotionalPrice',
  'UCIV',
  'RRP',
  'POR',
  'DRSApplicable',
  'DRSSingleQtyCharge',
].join(',');

/** The website's page size. Only a default — pagination follows the response. */
export const DEFAULT_PAGE_SIZE = 36;

export interface ProductPageQuery {
  offset: number;
  amount: number;
}

/** Join a category's ancestor chain into the path the API expects. */
export function categoryPathSegment(pathSegments: readonly string[]): string {
  return pathSegments
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Fetch a single page of products for one category.
 *
 * `pathSegments` must be the full ancestor chain ending with the category
 * itself, e.g. ["RetailWebHierarchy", "WebCat_405879"].
 */
export async function fetchCategoryProductsPage(
  pathSegments: readonly string[],
  { offset, amount }: ProductPageQuery,
): Promise<MusgraveApiResponse<unknown>> {
  const query: Record<string, string> = {
    amount: String(amount),
    offset: String(offset),
    sortKey: 'Position',
    returnSortKeys: 'true',
    productFilter: 'fallback_searchquerydefinition',
    attrs: MUSGRAVE_PRODUCT_ATTRS,
    labelAttributeGroup: 'PRODUCT_LABEL_ATTRIBUTES',
    attributeGroup: 'PRODUCT_API_ATTRIBUTES',
  };

  const path = categoryPathSegment(pathSegments);

  if (!path) {
    throw new Error('fetchCategoryProductsPage requires a non-empty category path');
  }

  log.debug('Requesting product page', { path, offset, amount });

  return musgraveApiGet<unknown>(`categories/${path}/products`, query);
}
