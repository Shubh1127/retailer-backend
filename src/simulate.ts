/**
 * TEST-MODE simulator.
 *
 * Live supplier price-fetching requires the retailer's real logged-in browser
 * (the spike). For a runnable, clickable test build, this module produces a rich,
 * deterministic-yet-varying dataset so the WHOLE pipeline (map → refresh →
 * compare → allocate → basket) works end-to-end offline. Prices are clearly
 * SIMULATED; swap this for the real userscript-runner results in production.
 */

import { computeCheckDigit } from './gtin.js';
import { importEposListing, type ShopArticle } from './ingest/eposListing.js';
import { defaultSuppliers } from './store.js';
import type { CanonicalProduct, PriceQuote, ProductMatch, Uom } from './types.js';
import type { Store, OrderLine } from './store.js';

/** Deterministic 32-bit hash. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Build a valid 14-digit GTIN from an article code (synthetic but consistent). */
function syntheticGtin(articleCode: string): string {
  const digits = ('5' + (hash(articleCode) % 1_000_000_000_000).toString().padStart(11, '0')).slice(0, 12);
  const ean13 = digits + computeCheckDigit(digits);
  return ean13.padStart(14, '0');
}

function uomFromPack(a: ShopArticle): Uom {
  // EPOS pack has no uom; infer a plausible one from size for display.
  if (!a.unitSize) return 'each';
  if (a.unitSize >= 100) return 'g';
  return 'each';
}

/**
 * Seed a full demo catalog from a real EPOS listing: each article becomes a
 * canonical product with a synthetic EAN, mapped across a realistic subset of the
 * 6 suppliers, each with a simulated case price around the article's cost.
 */
export function buildDemoCatalog(eposBuffer: Buffer, opts: { capturedAt: string; maxArticles?: number }) {
  const { articles } = importEposListing(eposBuffer);
  const suppliers = defaultSuppliers();
  const withCost = articles.filter((a) => a.mainCost && a.mainCost > 0).slice(0, opts.maxArticles ?? 80);

  const products: CanonicalProduct[] = [];
  const matches: ProductMatch[] = [];
  const quotes: PriceQuote[] = [];
  const orderLines: OrderLine[] = [];

  for (const a of withCost) {
    const gtin = syntheticGtin(a.articleCode);
    const uom = uomFromPack(a);
    products.push({ unitGtin: gtin, name: a.description, brand: '', isPmp: false, isOwnBrand: false });
    orderLines.push({ articleCode: a.articleCode, unitGtin: gtin, description: a.description, packRaw: a.packRaw, cases: a.cases, ...(a.mainCost !== undefined ? { mainCost: a.mainCost } : {}) });

    for (const s of suppliers) {
      const seed = hash(a.articleCode + s.id);
      // ~65-75% of suppliers stock a given product
      const stocked = (seed >> 5) % 100 < (s.isMain ? 92 : 62);
      if (!stocked) continue;
      const factor = 0.84 + ((seed >> 9) % 340) / 1000; // 0.84 .. 1.18
      const casePrice = Math.round((a.mainCost ?? 10) * factor * 100) / 100;
      const sku = `${s.id.slice(0, 2).toUpperCase()}-${(seed % 900000 + 100000)}`;
      matches.push({
        id: `${gtin}:${s.id}:${sku}`,
        unitGtin: gtin, supplierId: s.id, supplierSku: sku,
        supplierDescription: a.description,
        caseConfig: { unitsPerCase: a.unitsPerCase ?? 1, unitSize: a.unitSize ?? 1, uom, isCatchWeight: false },
        provenance: (seed % 5 === 0 ? 'llm_suggested' : 'ean_exact'),
        confidence: seed % 5 === 0 ? 0.72 : 1,
        isPmp: false, isOwnBrand: false,
        productUrl: `https://${s.id}.example/product/${sku}`,
        confirmed: seed % 5 !== 0,
        lastSuccessfulRefreshAt: opts.capturedAt,
      });
      quotes.push({
        supplierId: s.id, supplierSku: sku, rawCasePrice: casePrice,
        priceIsVatInclusive: false, vatRate: 0, isPromo: (seed % 11 === 0),
        capturedAt: opts.capturedAt,
        ...((seed % 11 === 0) ? { promoEndDate: '2026-12-31' } : {}),
      });
    }
  }
  return { products, matches, quotes, orderLines, articles: withCost };
}

/**
 * Simulate a fresh price refresh: nudge each quote by a small deterministic-random
 * delta so "N price changes detected" is demonstrable. Returns the changes.
 */
export function simulateRefresh(store: Store, capturedAt: string) {
  const seedBase = hash(capturedAt);
  const changes: { supplierId: string; supplierSku: string; oldCasePrice: number; newCasePrice: number; changePct: number }[] = [];
  const updated: PriceQuote[] = store.quotes.map((q) => {
    const seed = hash(q.supplierId + q.supplierSku) ^ seedBase;
    // ~25% of prices move each refresh, by -6%..+6%
    const moves = (seed >> 3) % 100 < 25;
    if (!moves) return q;
    const delta = (((seed >> 7) % 121) - 60) / 1000; // -0.06 .. +0.06
    const newPrice = Math.max(0.5, Math.round(q.rawCasePrice * (1 + delta) * 100) / 100);
    if (newPrice !== q.rawCasePrice) {
      changes.push({ supplierId: q.supplierId, supplierSku: q.supplierSku, oldCasePrice: q.rawCasePrice, newCasePrice: newPrice, changePct: newPrice / q.rawCasePrice - 1 });
    }
    return { ...q, rawCasePrice: newPrice, capturedAt };
  });
  return { updated, changes };
}
