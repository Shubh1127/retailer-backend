/**
 * Musgrave Category API — fetching only.
 *
 * No parsing, no persistence: this module's whole job is to get the raw document
 * off the wire using the existing authenticated client, which supplies the
 * dynamic `spgid` from the personalization call.
 *
 *   GET /categories;spgid={SPGID}
 *       ?imageView=NO-IMAGE&view=tree&limit=1&omitHasOnlineProducts=true
 */

import { musgraveApiGet, type MusgraveApiResponse } from './musgrave.service.js';
import { createLogger } from '../log.js';

const log = createLogger('musgrave:categories:api');

/** Query string exactly as the category tree endpoint expects it. */
export const MUSGRAVE_CATEGORY_QUERY: Readonly<Record<string, string>> = Object.freeze({
  imageView: 'NO-IMAGE',
  view: 'tree',
  limit: '1',
  omitHasOnlineProducts: 'true',
});

export const MUSGRAVE_CATEGORY_PATH = 'categories';

/**
 * Fetch the raw category tree. The response is returned untouched — shape
 * handling belongs to the parser — along with the URL and spgid used, which the
 * sync records for traceability.
 *
 * `queryOverrides` lets a caller widen the request (e.g. a different `limit`)
 * without this module owning that policy.
 */
export async function fetchMusgraveCategoryTree(
  queryOverrides: Record<string, string> = {},
): Promise<MusgraveApiResponse<unknown>> {
  const query = { ...MUSGRAVE_CATEGORY_QUERY, ...queryOverrides };

  log.info('Requesting category tree', { query });

  const response = await musgraveApiGet<unknown>(MUSGRAVE_CATEGORY_PATH, query);

  log.info('Category tree received', {
    url: response.url,
    bytes: JSON.stringify(response.data ?? null).length,
  });

  return response;
}
