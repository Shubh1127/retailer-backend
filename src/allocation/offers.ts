/**
 * Turn raw matches + price quotes into clean, comparable per-line offers that the
 * allocation engine can route on. This is where promo-validity and the outlier
 * sanity check are applied, so the engine itself stays a pure decision function.
 *
 * Only allocatable matches (invoice / ean_exact / human_confirmed) may produce an
 * offer. 'llm_suggested' rows are candidates for the confirmation UI only.
 */

import type {
  AllocationConfig,
  CanonicalProduct,
  OrderRequestLine,
  PriceQuote,
  ProductMatch,
  Supplier,
} from '../types.js';
import {
  flagOutliers,
  isPromoValidOn,
  normalizePrice,
  type NormalizedPrice,
} from '../pricing/normalize.js';

/** A single supplier's resolved, comparable price for one requested product. */
export interface SupplierOffer {
  supplierId: string;
  supplierSku: string;
  exVatCasePrice: number;
  exVatPerBaseUnit: number;
  /** 'promo' when a still-valid promo price was used, else 'list'. */
  priceSource: 'promo' | 'list';
}

/** Everything the allocator needs to decide one requested line. */
export interface AllocationLineInput {
  unitGtin: string;
  cases: number;
  offers: SupplierOffer[];
  /** Catch-weight/variable-weight → excluded from auto-allocation, routed to manual. */
  isCatchWeight: boolean;
  /** True when candidates existed but every one was filtered (outlier/promo/no data). */
  hadFilteredCandidates: boolean;
  /** Per-item pin: force this line to a specific supplier regardless of price. */
  pinnedSupplierId?: string;
}

const ALLOCATABLE: ReadonlySet<string> = new Set(['invoice', 'ean_exact', 'human_confirmed']);

export interface PrepareContext {
  matches: ProductMatch[];
  quotes: PriceQuote[];
  suppliers: Map<string, Supplier>;
  products: Map<string, CanonicalProduct>;
  config: AllocationConfig;
  /** Optional pins: unitGtin → supplierId. */
  pins?: Map<string, string>;
  /**
   * Optional list-price fallback for promos, keyed `${supplierId}:${supplierSku}`
   * → ex-VAT-per-base-unit. Used when a promo has lapsed by the order date.
   */
  listFallback?: Map<string, NormalizedPrice>;
}

/**
 * Build the allocator input for one requested line. Applies: allocatable filter,
 * per-supplier price adjustment, promo validity (falls back to list price, or
 * drops the offer if no valid price), and the cross-supplier outlier check.
 */
export function prepareLine(line: OrderRequestLine, ctx: PrepareContext): AllocationLineInput {
  const product = ctx.products.get(line.unitGtin);
  const isCatchWeight = ctx.matches
    .filter((m) => m.unitGtin === line.unitGtin)
    .some((m) => m.caseConfig.isCatchWeight);

  const quoteBySku = new Map<string, PriceQuote>();
  for (const q of ctx.quotes) quoteBySku.set(`${q.supplierId}:${q.supplierSku}`, q);

  const candidateMatches = ctx.matches.filter(
    (m) => m.unitGtin === line.unitGtin && ALLOCATABLE.has(m.provenance),
  );
  const hadAnyCandidate = ctx.matches.some((m) => m.unitGtin === line.unitGtin);

  // Enforce PMP / own-brand hard constraints against the canonical product.
  const constrained = candidateMatches.filter((m) => {
    if (!product) return true;
    return m.isPmp === product.isPmp && m.isOwnBrand === product.isOwnBrand;
  });

  const normalized: NormalizedPrice[] = [];
  for (const m of constrained) {
    const q = quoteBySku.get(`${m.supplierId}:${m.supplierSku}`);
    if (!q) continue; // no current price for this supplier SKU
    const supplier = ctx.suppliers.get(m.supplierId);
    const adj = supplier?.priceAdjustmentPct ?? 0;
    normalized.push(normalizePrice(q, m.caseConfig, adj));
  }

  // Outlier sanity check across suppliers for this product.
  const { kept, flagged } = flagOutliers(normalized, ctx.config.outlierDeviation);

  // Resolve promos against the order date.
  const offers: SupplierOffer[] = [];
  for (const p of kept) {
    let usable: NormalizedPrice | undefined = p;
    let priceSource: 'promo' | 'list' = p.isPromo ? 'promo' : 'list';
    if (p.isPromo && !isPromoValidOn(p, ctx.config.orderDate)) {
      const fb = ctx.listFallback?.get(`${p.supplierId}:${p.supplierSku}`);
      usable = fb; // fall back to list price; if none, drop this offer
      priceSource = 'list';
    }
    if (!usable) continue;
    offers.push({
      supplierId: usable.supplierId,
      supplierSku: usable.supplierSku,
      exVatCasePrice: usable.exVatCasePrice,
      exVatPerBaseUnit: usable.exVatPerBaseUnit,
      priceSource,
    });
  }

  const result: AllocationLineInput = {
    unitGtin: line.unitGtin,
    cases: line.cases,
    offers,
    isCatchWeight,
    hadFilteredCandidates: hadAnyCandidate && offers.length === 0 && (flagged.length > 0 || constrained.length > 0),
  };
  const pin = ctx.pins?.get(line.unitGtin);
  if (pin) result.pinnedSupplierId = pin;
  return result;
}
