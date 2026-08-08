/**
 * Shared supplier-search layer.
 *
 * One place that knows "search every supplier for this query and hand back the
 * raw card plus the normalized records". Both the single-product comparison
 * (`compare.service.ts`) and the order-file preparation
 * (`orderFile.service.ts`) go through here, so the supplier roster and the
 * failure/concurrency behaviour exist once rather than twice.
 *
 * Two properties matter for batch work and are the reason this layer exists:
 *
 *  - **Raw cards are preserved.** The connectors' `normalizeCard` throws the
 *    original `SearchCard` away, but `pickBestMatch` needs it to disambiguate
 *    several results for one product. Hits carry both.
 *  - **Failures are isolated per supplier.** A Musgrave login failure must not
 *    lose the O'Reilly prices for a 15-line order; it is reported and the run
 *    continues.
 */

import { searchMusgrave } from './musgrave.service.js';
import { searchOreilly } from './oreilly.service.js';
import type { NormalizedCard, SearchCard } from '../connectors/types.js';
import type { Supplier } from '../types.js';

/** A normalized supplier result that still carries the card it came from. */
export type SupplierSearchHit = NormalizedCard & { card: SearchCard };

export interface SupplierSearchError {
  supplierId: string;
  message: string;
}

export interface SupplierSearchResult {
  /** supplierId → that supplier's hits (absent when the supplier errored). */
  hits: Map<string, SupplierSearchHit[]>;
  errors: SupplierSearchError[];
}

export interface SupplierSearchOptions {
  /**
   * Cap how many results get an extra detail-page fetch (O'Reilly needs one per
   * card for its EAN and pack size). Undefined keeps each connector's own
   * default.
   */
  maxDetails?: number;
}

/**
 * Supplier configuration for comparison and allocation.
 *
 * Ranked buying preference plus each supplier's own compare threshold: a line
 * only moves off the more-preferred supplier when the alternative beats it by
 * more than the alternative's own threshold. Mirrors the existing app's
 * per-supplier rule (Musgrave 10%, others 13%).
 *
 * TODO: this is currently static; it moves to persistent storage alongside the
 * mappings cockpit's editable margin / min-order fields.
 */
export const SUPPLIERS: Map<string, Supplier> = new Map<string, Supplier>([
  [
    'musgrave',
    {
      id: 'musgrave',
      name: 'Musgrave',
      isMain: true,
      preferenceRank: 1,
      channel: 'webview-cart',
      minOrderValue: 0,
      deliveryFee: 0,
      freeDeliveryThreshold: undefined,
      priceAdjustmentPct: 0,
      thresholdPct: 0.1,
    },
  ],
  [
    'oreilly',
    {
      id: 'oreilly',
      name: "O'Reilly",
      isMain: false,
      preferenceRank: 2,
      channel: 'webview-cart',
      minOrderValue: 0,
      deliveryFee: 0,
      freeDeliveryThreshold: undefined,
      priceAdjustmentPct: 0,
      thresholdPct: 0.13,
    },
  ],
]);

/** Supplier ids searched by a comparison, in preference order. */
export const SUPPLIER_IDS: readonly string[] = [...SUPPLIERS.keys()];

type SearchFn = (
  query: string,
  opts?: SupplierSearchOptions,
) => Promise<SupplierSearchHit[]>;

const SEARCH_FNS: Record<string, SearchFn> = {
  musgrave: (query) => searchMusgrave(query),
  oreilly: (query, opts) => searchOreilly(query, opts),
};

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const s = String(e);
  // Supplier portals answer failures with whole HTML pages; keep it readable.
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * Search every configured supplier concurrently. Never rejects: a supplier that
 * throws is recorded in `errors` and simply contributes no hits.
 */
export async function searchAllSuppliers(
  query: string,
  opts: SupplierSearchOptions = {},
): Promise<SupplierSearchResult> {
  const hits = new Map<string, SupplierSearchHit[]>();
  const errors: SupplierSearchError[] = [];

  await Promise.all(
    SUPPLIER_IDS.map(async (supplierId) => {
      const search = SEARCH_FNS[supplierId];
      if (!search) return;
      try {
        hits.set(supplierId, await search(query, opts));
      } catch (e) {
        errors.push({ supplierId, message: errorMessage(e) });
      }
    }),
  );

  return { hits, errors };
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the results. Batch order preparation walks 15+ products across two
 * logged-in trade accounts, so unbounded fan-out is not an option.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/** Pause for `ms` (used to keep supplier requests human-paced). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
