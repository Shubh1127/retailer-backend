/**
 * Live price refresh — the "fetch the real price for this moment" step that runs
 * when the user hits Compare.
 *
 * Mirrors how the existing desktop app works (reverse-engineered):
 *   - DISCOVERY is expensive and happens once per product: search a supplier by
 *     EAN, store its product code in the matching table.
 *   - REFRESH is cheap and happens at compare time: walk the KNOWN product codes
 *     via direct product URLs (no searching), read the current price, diff
 *     against the cache → "N price changes detected".
 *
 * The backend builds the fetch PLAN and applies the RESULTS; the actual page
 * loads happen on-device in the logged-in WebView (prices are login-gated and
 * bot-managed, so requests must come from the shop's own session/IP).
 */

import type { Store } from './store.js';
import { connectorFor, type SearchCard } from './connectors/index.js';
import type { OrderRequestLine, PriceQuote } from './types.js';

/** GTIN-14 → the 13-digit EAN form supplier search boxes expect. */
export function gtin14ToEan13(gtin14: string): string {
  return gtin14.length === 14 && gtin14.startsWith('0') ? gtin14.slice(1) : gtin14;
}

/** One page the on-device WebView should load. */
export interface FetchTask {
  /** 'refresh' = direct product page via stored code; 'discover' = EAN search. */
  kind: 'refresh' | 'discover';
  supplierId: string;
  unitGtin: string;
  /** Present on refresh tasks — the stored supplier product code. */
  supplierSku?: string;
  url: string;
}

export interface FetchPlan {
  tasks: FetchTask[];
  /** Suppliers in the store with no connector yet (price file / manual only). */
  suppliersWithoutConnector: string[];
  /** Items NOT fetched because their cached quote is still fresh (hit saved). */
  skippedFresh: number;
}

export interface FetchPlanOptions {
  /**
   * Freshness window: skip refetching a quote captured within this many hours.
   * The single biggest hit-reducer — a price fetched this morning is not
   * fetched again this afternoon. Default 12h; pass 0 to force-refresh all.
   */
  maxQuoteAgeHours?: number;
  /** "Now" for age math (ISO). Injectable for tests. */
  now?: string;
}

/**
 * Build the fetch plan for a set of order lines (or the whole catalog when no
 * lines are given). For each product × supplier:
 *   - mapped + connector + stale quote → direct product-URL refresh task
 *   - mapped + FRESH quote             → skipped entirely (no hit at all)
 *   - unmapped + connector             → EAN-search discovery task
 *   - supplier has no connector        → listed once in suppliersWithoutConnector
 *
 * Tasks are INTERLEAVED round-robin across suppliers so each individual site
 * sees 1/N of the request rate — the driver's pacing then applies on top. The
 * goal is the least hits per supplier and human-plausible cadence; a full run
 * is allowed to take minutes.
 */
export function buildFetchPlan(
  store: Store,
  lines?: OrderRequestLine[],
  opts: FetchPlanOptions = {},
): FetchPlan {
  const gtins = lines?.length
    ? [...new Set(lines.map((l) => l.unitGtin))]
    : store.products.map((p) => p.unitGtin);

  const maxAgeMs = (opts.maxQuoteAgeHours ?? 12) * 3600_000;
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const quoteByKey = new Map(store.quotes.map((q) => [`${q.supplierId}:${q.supplierSku}`, q]));

  const perSupplier: FetchTask[][] = [];
  const noConnector = new Set<string>();
  let skippedFresh = 0;

  for (const supplier of store.suppliers) {
    const connector = connectorFor(supplier.id);
    if (!connector) {
      noConnector.add(supplier.id);
      continue;
    }
    const queue: FetchTask[] = [];
    for (const gtin of gtins) {
      const match = store.matches.find((m) => m.unitGtin === gtin && m.supplierId === supplier.id);
      if (match) {
        // Freshness window: a recent price is NOT refetched — zero hits.
        const cached = quoteByKey.get(`${supplier.id}:${match.supplierSku}`);
        if (cached && maxAgeMs > 0 && nowMs - Date.parse(cached.capturedAt) < maxAgeMs) {
          skippedFresh++;
          continue;
        }
        // Prefer the URL observed at discovery; fall back to constructing one
        // from the stored SKU; only unmapped items pay for a search.
        const directUrl = match.productUrl ?? connector.productUrl?.(match.supplierSku);
        if (directUrl) {
          queue.push({ kind: 'refresh', supplierId: supplier.id, unitGtin: gtin, supplierSku: match.supplierSku, url: directUrl });
          continue;
        }
      }
      queue.push({ kind: 'discover', supplierId: supplier.id, unitGtin: gtin, url: connector.searchUrlByEan(gtin14ToEan13(gtin)) });
    }
    if (queue.length) perSupplier.push(queue);
  }

  // Round-robin interleave: each site sees 1/N of the request rate.
  const tasks: FetchTask[] = [];
  const maxLen = Math.max(0, ...perSupplier.map((q) => q.length));
  for (let i = 0; i < maxLen; i++) {
    for (const queue of perSupplier) {
      const t = queue[i];
      if (t) tasks.push(t);
    }
  }

  return { tasks, suppliersWithoutConnector: [...noConnector], skippedFresh };
}

/** What the WebView hands back for one completed task. */
export interface FetchResult {
  supplierId: string;
  unitGtin: string;
  /** The extracted card; null/absent when the product wasn't found (delisted). */
  card?: SearchCard | null;
}

export interface PriceChange {
  supplierId: string;
  supplierSku: string;
  unitGtin: string;
  oldCasePrice: number;
  newCasePrice: number;
  /** Signed fraction, e.g. +0.03 = 3% dearer than cached. */
  changePct: number;
}

export interface ApplyResultSummary {
  /** Quotes upserted (fresh prices now in the store). */
  updated: number;
  /** New products/matches discovered (was a 'discover' task that hit). */
  discovered: number;
  /** The diff vs the cached prices — the "N price changes detected" list. */
  priceChanges: PriceChange[];
  /** Tasks that came back empty — product not found at that supplier. */
  notFound: { supplierId: string; unitGtin: string }[];
  /**
   * REJECTED results: the page's EAN did not match the expected EAN (stale/
   * reused URL, product swapped behind the link). Nothing was upserted for
   * these — re-discover them by EAN search.
   */
  eanMismatch: { supplierId: string; unitGtin: string; pageEan: string }[];
}

/** Compare a page-displayed EAN against the expected canonical GTIN. */
function eanMatches(expectedGtin: string, pageEanText: string): boolean {
  const digits = pageEanText.replace(/\D/g, '');
  if (!digits) return false;
  return digits.padStart(14, '0') === expectedGtin.padStart(14, '0');
}

/**
 * Apply WebView fetch results: normalize each card via its supplier connector,
 * diff against the cached quote, and upsert everything into the store.
 */
export async function applyFetchResults(
  store: Store,
  results: FetchResult[],
  capturedAt: string,
): Promise<ApplyResultSummary> {
  const oldQuoteByKey = new Map<string, PriceQuote>();
  for (const q of store.quotes) oldQuoteByKey.set(`${q.supplierId}:${q.supplierSku}`, q);
  const hadMatch = new Set(store.matches.map((m) => `${m.unitGtin}:${m.supplierId}`));

  const products = [];
  const matches = [];
  const quotes = [];
  const priceChanges: PriceChange[] = [];
  const notFound: ApplyResultSummary['notFound'] = [];
  const eanMismatch: ApplyResultSummary['eanMismatch'] = [];
  let discovered = 0;

  for (const r of results) {
    if (!r.card) {
      notFound.push({ supplierId: r.supplierId, unitGtin: r.unitGtin });
      continue;
    }
    const connector = connectorFor(r.supplierId);
    if (!connector) continue;
    // EAN + URL must both check out: when the page shows an EAN, it must equal
    // the expected one, or we reject the whole result (no price upserted).
    if (r.card.eanText && !eanMatches(r.unitGtin, r.card.eanText)) {
      eanMismatch.push({ supplierId: r.supplierId, unitGtin: r.unitGtin, pageEan: r.card.eanText });
      continue;
    }
    const n = connector.normalize(r.card, { unitGtin: r.unitGtin, capturedAt });
    products.push(n.product);
    matches.push(n.match);
    quotes.push(n.quote);

    if (!hadMatch.has(`${r.unitGtin}:${r.supplierId}`)) discovered++;

    const old = oldQuoteByKey.get(`${n.quote.supplierId}:${n.quote.supplierSku}`);
    if (old && Math.abs(old.rawCasePrice - n.quote.rawCasePrice) > 0.004) {
      priceChanges.push({
        supplierId: n.quote.supplierId,
        supplierSku: n.quote.supplierSku,
        unitGtin: r.unitGtin,
        oldCasePrice: old.rawCasePrice,
        newCasePrice: n.quote.rawCasePrice,
        changePct: n.quote.rawCasePrice / old.rawCasePrice - 1,
      });
    }
  }

  await store.mergeImport({ products, matches, quotes });
  return { updated: quotes.length, discovered, priceChanges, notFound, eanMismatch };
}
