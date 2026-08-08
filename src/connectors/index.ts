/**
 * Connector registry. Add a supplier by dropping in a module and registering it.
 * Fetching is on-device; these provide URL patterns + card normalization.
 */

import type { SupplierConnector } from './types.js';
import { musgraveConnector } from './musgrave.js';
import { barryGroupConnector } from './barrygroup.js';

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
