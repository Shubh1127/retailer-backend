/**
 * Price normalization.
 *
 * Everything is reduced to an EX-VAT price-per-base-unit so that suppliers can be
 * compared apples-to-apples regardless of case size, unit size, uom, or whether
 * the portal displays VAT-inclusive prices. Comparisons must NEVER run on raw
 * case prices — VAT and pack-size differences are larger than the whole 5–10%
 * preference band.
 */

import type { CaseConfig, PriceQuote, Uom } from '../types.js';

/** Base uom used for comparison within a measurement family. */
type BaseFamily = 'count' | 'volume' | 'mass';

interface UomInfo {
  family: BaseFamily;
  /** Multiplier to convert one `uom` into the family's base (each / ml / g). */
  toBase: number;
}

const UOM_TABLE: Record<Uom, UomInfo> = {
  each: { family: 'count', toBase: 1 },
  ml: { family: 'volume', toBase: 1 },
  l: { family: 'volume', toBase: 1000 },
  g: { family: 'mass', toBase: 1 },
  kg: { family: 'mass', toBase: 1000 },
};

/** Convert a display price to ex-VAT. */
export function toExVat(price: number, vatRate: number, isVatInclusive: boolean): number {
  if (vatRate < 0) throw new Error(`Negative VAT rate: ${vatRate}`);
  return isVatInclusive ? price / (1 + vatRate) : price;
}

/** The base family and base-unit quantity contained in one CASE. */
export function caseBaseQuantity(cc: CaseConfig): { family: BaseFamily; quantity: number } {
  const info = UOM_TABLE[cc.uom];
  return { family: info.family, quantity: cc.unitsPerCase * cc.unitSize * info.toBase };
}

/** A fully-normalized, comparable price line for one supplier's version of a product. */
export interface NormalizedPrice {
  supplierId: string;
  supplierSku: string;
  /** Ex-VAT price for one case. */
  exVatCasePrice: number;
  /** Base measurement family (count/volume/mass) — only same-family prices compare. */
  family: BaseFamily;
  /** Ex-VAT price per base unit (per each / per ml / per g). */
  exVatPerBaseUnit: number;
  isCatchWeight: boolean;
  isPromo: boolean;
  promoEndDate?: string;
  capturedAt: string;
}

/**
 * Normalize a raw quote + its case config into an ex-VAT price-per-base-unit.
 * `priceAdjustmentPct` applies an optional per-supplier rebate/terms adjustment
 * (negative lowers the effective price); defaults to 0 (off).
 */
export function normalizePrice(
  quote: PriceQuote,
  caseConfig: CaseConfig,
  priceAdjustmentPct = 0,
): NormalizedPrice {
  const exVat = toExVat(quote.rawCasePrice, quote.vatRate, quote.priceIsVatInclusive);
  const adjusted = exVat * (1 + priceAdjustmentPct);
  const { family, quantity } = caseBaseQuantity(caseConfig);
  if (quantity <= 0) {
    throw new Error(
      `Non-positive base quantity for ${quote.supplierId}/${quote.supplierSku} — check case config`,
    );
  }
  return {
    supplierId: quote.supplierId,
    supplierSku: quote.supplierSku,
    exVatCasePrice: adjusted,
    family,
    exVatPerBaseUnit: adjusted / quantity,
    isCatchWeight: caseConfig.isCatchWeight,
    isPromo: quote.isPromo,
    ...(quote.promoEndDate ? { promoEndDate: quote.promoEndDate } : {}),
    capturedAt: quote.capturedAt,
  };
}

/**
 * Promo validity: a promo price only counts if it is still valid at the planned
 * order date. Otherwise the caller should fall back to the supplier's list price.
 */
export function isPromoValidOn(price: NormalizedPrice, orderDateIso: string): boolean {
  if (!price.isPromo) return true; // non-promo prices are always valid
  if (!price.promoEndDate) return false; // promo with no end date can't be trusted forward
  return price.promoEndDate >= orderDateIso;
}

/** Median of a numeric list (empty → NaN). */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface OutlierResult {
  /** Prices whose per-base-unit is within tolerance of the median. */
  kept: NormalizedPrice[];
  /** Prices flagged as probable parse errors — excluded from routing. */
  flagged: NormalizedPrice[];
}

/**
 * Outlier sanity check. Given the normalized prices for ONE product across
 * suppliers, flag any whose ex-VAT-per-base-unit deviates from the cross-supplier
 * median by more than `deviation` (a probable case-size/VAT parse error). Flagged
 * prices are returned separately so the caller can exclude them from routing and
 * surface them for review rather than confidently ordering wrong.
 */
export function flagOutliers(prices: NormalizedPrice[], deviation: number): OutlierResult {
  if (prices.length < 3) {
    // Need at least a few points for a meaningful median; don't flag on thin data.
    return { kept: [...prices], flagged: [] };
  }
  const med = median(prices.map((p) => p.exVatPerBaseUnit));
  const kept: NormalizedPrice[] = [];
  const flagged: NormalizedPrice[] = [];
  for (const p of prices) {
    const rel = Math.abs(p.exVatPerBaseUnit - med) / med;
    if (rel > deviation) flagged.push(p);
    else kept.push(p);
  }
  return { kept, flagged };
}
