/**
 * Deterministic, basket-aware allocation engine — the core product.
 *
 * Rule (the owner's ask): the MAIN supplier keeps every line unless another
 * supplier is cheaper by MORE than the preference band (e.g. 5% / 10%). Ties and
 * small differences stay with main. Then a repair pass reassigns least-loss lines
 * to clear any supplier basket that fell below its minimum order value.
 *
 * Determinism: no Date.now / Math.random; ties broken by (price, supplierId).
 * Catch-weight lines and lines with no allocatable offer are never auto-routed.
 */

import type { AllocationConfig, Supplier } from '../types.js';
import type { AllocationLineInput, SupplierOffer } from './offers.js';

export type LineStatus =
  | 'allocated'
  | 'manual-catch-weight'
  | 'unmatched'
  | 'flagged-review';

export interface LineAllocation {
  unitGtin: string;
  cases: number;
  status: LineStatus;
  supplierId?: string;
  supplierSku?: string;
  exVatCasePrice?: number;
  exVatPerBaseUnit?: number;
  lineExVatTotal?: number;
  /** True when a line was moved off the main supplier because another beat the band. */
  divertedFromMain?: boolean;
  /** True when the line was placed by an explicit per-item pin. */
  pinned?: boolean;
  /** Saving vs ordering this line from the main supplier (>=0), when comparable. */
  savingVsMain?: number;
  reason: string;
}

export interface SupplierBasket {
  supplierId: string;
  name: string;
  lineCount: number;
  goodsExVat: number;
  deliveryFee: number;
  meetsMinOrder: boolean;
  meetsFreeDelivery: boolean;
}

export interface AllocationResult {
  lines: LineAllocation[];
  baskets: SupplierBasket[];
  totalGoodsExVat: number;
  totalDeliveryExVat: number;
  grandTotalExVat: number;
  /** Baseline: the same lines ordered entirely from the main supplier (where it can supply). */
  baselineAllFromMainExVat: number;
  /** grandTotal saving vs the all-from-main baseline (goods + delivery). */
  totalSavingExVat: number;
  counts: {
    allocated: number;
    manualCatchWeight: number;
    unmatched: number;
    flaggedReview: number;
    divertedFromMain: number;
  };
}

function cheapestOffer(offers: SupplierOffer[]): SupplierOffer | undefined {
  if (offers.length === 0) return undefined;
  return [...offers].sort(
    (a, b) => a.exVatPerBaseUnit - b.exVatPerBaseUnit || a.supplierId.localeCompare(b.supplierId),
  )[0];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Pick the winning supplier for a single line under the ranked-preference rule.
 *
 * The line is ANCHORED on the most-preferred (lowest preferenceRank) supplier that
 * actually stocks it — that is the buyer's default. It stays there unless the
 * cheapest offer beats the anchor's per-base-unit price by MORE than the cheaper
 * supplier's own compare threshold. This generalises the old single-"main" rule:
 * with ranks 1..N, a line only slides down the preference list when the saving is
 * big enough to justify moving off the preferred supplier.
 */
function chooseWinner(
  line: AllocationLineInput,
  rankOf: (supplierId: string) => number,
  band: number,
  thresholdFor: (supplierId: string) => number,
): { offer: SupplierOffer; anchorId: string | undefined; divertedFromMain: boolean } | undefined {
  // Explicit pin wins if that supplier actually offers the line.
  if (line.pinnedSupplierId) {
    const pinned = line.offers.find((o) => o.supplierId === line.pinnedSupplierId);
    if (pinned) return { offer: pinned, anchorId: pinned.supplierId, divertedFromMain: false };
  }

  const cheapest = cheapestOffer(line.offers);
  if (!cheapest) return undefined;

  // Anchor = most-preferred (lowest rank) supplier that offers this line.
  const anchor = [...line.offers].sort((a, b) => rankOf(a.supplierId) - rankOf(b.supplierId))[0];
  if (!anchor) return { offer: cheapest, anchorId: undefined, divertedFromMain: false };

  // Keep the anchor unless the cheapest beats it by MORE than the cheaper
  // supplier's own compare threshold (falls back to the global band).
  const relCheaper = (anchor.exVatPerBaseUnit - cheapest.exVatPerBaseUnit) / anchor.exVatPerBaseUnit;
  const threshold = thresholdFor(cheapest.supplierId);
  if (cheapest.supplierId !== anchor.supplierId && relCheaper > threshold) {
    return { offer: cheapest, anchorId: anchor.supplierId, divertedFromMain: true };
  }
  return { offer: anchor, anchorId: anchor.supplierId, divertedFromMain: false };
}

export function allocate(
  lines: AllocationLineInput[],
  suppliers: Supplier[],
  config: AllocationConfig,
): AllocationResult {
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const thresholdFor = (id: string) => supplierById.get(id)?.thresholdPct ?? config.preferenceBand;
  // Ranked preference: explicit preferenceRank, else main→1, else order in the list.
  const rankOf = (id: string): number => {
    const s = supplierById.get(id);
    if (!s) return Number.MAX_SAFE_INTEGER;
    if (typeof s.preferenceRank === 'number') return s.preferenceRank;
    if (s.isMain) return 1;
    return 100 + suppliers.indexOf(s);
  };
  // The overall first-preference supplier (used as the reporting baseline).
  const main = [...suppliers].sort((a, b) => rankOf(a.id) - rankOf(b.id))[0];
  const results: LineAllocation[] = [];

  for (const line of lines) {
    if (line.isCatchWeight) {
      results.push({
        unitGtin: line.unitGtin,
        cases: line.cases,
        status: 'manual-catch-weight',
        reason: 'Variable/catch-weight product — cannot be compared per base unit; decide manually.',
      });
      continue;
    }
    if (line.offers.length === 0) {
      results.push({
        unitGtin: line.unitGtin,
        cases: line.cases,
        status: line.hadFilteredCandidates ? 'flagged-review' : 'unmatched',
        reason: line.hadFilteredCandidates
          ? 'Candidates existed but were filtered (price outlier / lapsed promo / no current price) — review.'
          : 'No confirmed supplier match — confirm a match before this line can be allocated.',
      });
      continue;
    }

    const win = chooseWinner(line, rankOf, config.preferenceBand, thresholdFor);
    if (!win) {
      results.push({
        unitGtin: line.unitGtin,
        cases: line.cases,
        status: 'unmatched',
        reason: 'No offer could be selected.',
      });
      continue;
    }
    const lineTotal = round2(win.offer.exVatCasePrice * line.cases);
    const mainOffer = main ? line.offers.find((o) => o.supplierId === main.id) : undefined;
    const alloc: LineAllocation = {
      unitGtin: line.unitGtin,
      cases: line.cases,
      status: 'allocated',
      supplierId: win.offer.supplierId,
      supplierSku: win.offer.supplierSku,
      exVatCasePrice: round2(win.offer.exVatCasePrice),
      exVatPerBaseUnit: win.offer.exVatPerBaseUnit,
      lineExVatTotal: lineTotal,
      divertedFromMain: win.divertedFromMain,
      pinned: Boolean(line.pinnedSupplierId && win.offer.supplierId === line.pinnedSupplierId),
      reason: buildReason(win, supplierById),
    };
    if (mainOffer) {
      alloc.savingVsMain = round2((mainOffer.exVatCasePrice - win.offer.exVatCasePrice) * line.cases);
    }
    results.push(alloc);
  }

  // Basket-aware repair pass: dissolve any sub-minimum basket by moving its lines
  // to their next-best alternative (least added cost first).
  repairSubMinimumBaskets(results, lines, supplierById);

  return summarize(results, lines, suppliers);
}

function buildReason(
  win: { offer: SupplierOffer; anchorId: string | undefined; divertedFromMain: boolean },
  supplierById: Map<string, Supplier>,
): string {
  const anchorName = win.anchorId ? (supplierById.get(win.anchorId)?.name ?? win.anchorId) : undefined;
  if (!win.divertedFromMain && win.offer.supplierId === win.anchorId) {
    return `Preferred supplier kept${anchorName ? ` (${anchorName})` : ''} — no alternative beat it by more than its margin.`;
  }
  if (win.divertedFromMain && anchorName) {
    const winName = supplierById.get(win.offer.supplierId)?.name ?? win.offer.supplierId;
    return `Diverted to ${winName}: cheaper than ${anchorName} by more than the margin.`;
  }
  return 'Routed to cheapest available supplier.';
}

/** Reassign lines out of any basket that fell below the supplier's min order value. */
function repairSubMinimumBaskets(
  results: LineAllocation[],
  lines: AllocationLineInput[],
  supplierById: Map<string, Supplier>,
): void {
  const lineByGtin = new Map(lines.map((l) => [l.unitGtin, l]));

  // Iterate to a fixed point (moving lines can push another basket below min).
  for (let pass = 0; pass < supplierById.size + 1; pass++) {
    const goods = basketGoods(results);
    let changed = false;

    for (const [supplierId, supplier] of supplierById) {
      const total = goods.get(supplierId) ?? 0;
      if (total <= 0 || total >= supplier.minOrderValue) continue;

      // Move each allocated line of this supplier to its cheapest OTHER offer.
      for (const r of results) {
        if (r.status !== 'allocated' || r.supplierId !== supplierId) continue;
        const input = lineByGtin.get(r.unitGtin);
        if (!input) continue;
        const alt = cheapestOffer(input.offers.filter((o) => o.supplierId !== supplierId));
        if (!alt) continue; // nowhere to move it; leave as-is (surface as a warning upstream)
        r.supplierId = alt.supplierId;
        r.supplierSku = alt.supplierSku;
        r.exVatCasePrice = round2(alt.exVatCasePrice);
        r.exVatPerBaseUnit = alt.exVatPerBaseUnit;
        r.lineExVatTotal = round2(alt.exVatCasePrice * r.cases);
        r.reason = `Reassigned by repair pass: ${supplier.name} basket was below its €${supplier.minOrderValue} minimum.`;
        r.divertedFromMain = false;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function basketGoods(results: LineAllocation[]): Map<string, number> {
  const goods = new Map<string, number>();
  for (const r of results) {
    if (r.status === 'allocated' && r.supplierId) {
      goods.set(r.supplierId, (goods.get(r.supplierId) ?? 0) + (r.lineExVatTotal ?? 0));
    }
  }
  return goods;
}

function summarize(
  results: LineAllocation[],
  lines: AllocationLineInput[],
  suppliers: Supplier[],
): AllocationResult {
  const main = suppliers.find((s) => s.isMain);
  const goods = basketGoods(results);

  const baskets: SupplierBasket[] = suppliers
    .map((s) => {
      const g = round2(goods.get(s.id) ?? 0);
      const lineCount = results.filter((r) => r.status === 'allocated' && r.supplierId === s.id).length;
      const meetsFree = s.freeDeliveryThreshold !== undefined ? g >= s.freeDeliveryThreshold : true;
      const deliveryFee = g > 0 && !meetsFree ? s.deliveryFee : 0;
      return {
        supplierId: s.id,
        name: s.name,
        lineCount,
        goodsExVat: g,
        deliveryFee: round2(deliveryFee),
        meetsMinOrder: g === 0 || g >= s.minOrderValue,
        meetsFreeDelivery: meetsFree,
      };
    })
    .filter((b) => b.lineCount > 0);

  const totalGoods = round2(baskets.reduce((sum, b) => sum + b.goodsExVat, 0));
  const totalDelivery = round2(baskets.reduce((sum, b) => sum + b.deliveryFee, 0));
  const grandTotal = round2(totalGoods + totalDelivery);

  // Baseline: same lines from main where main can supply them.
  const lineByGtin = new Map(lines.map((l) => [l.unitGtin, l]));
  let baselineGoods = 0;
  let baselineComparableLines = 0;
  for (const r of results) {
    if (r.status !== 'allocated') continue;
    const input = lineByGtin.get(r.unitGtin);
    const mainOffer = main ? input?.offers.find((o) => o.supplierId === main.id) : undefined;
    if (mainOffer) {
      baselineGoods += mainOffer.exVatCasePrice * r.cases;
      baselineComparableLines++;
    } else {
      // Main can't supply — the allocated cost is the only option; count it in baseline too
      // so savings reflect only genuine main-vs-alternative choices.
      baselineGoods += r.lineExVatTotal ?? 0;
    }
  }
  const baseline = round2(baselineGoods);

  const counts = {
    allocated: results.filter((r) => r.status === 'allocated').length,
    manualCatchWeight: results.filter((r) => r.status === 'manual-catch-weight').length,
    unmatched: results.filter((r) => r.status === 'unmatched').length,
    flaggedReview: results.filter((r) => r.status === 'flagged-review').length,
    divertedFromMain: results.filter((r) => r.status === 'allocated' && r.divertedFromMain).length,
  };
  void baselineComparableLines;

  return {
    lines: results,
    baskets,
    totalGoodsExVat: totalGoods,
    totalDeliveryExVat: totalDelivery,
    grandTotalExVat: grandTotal,
    baselineAllFromMainExVat: baseline,
    totalSavingExVat: round2(baseline - totalGoods),
    counts,
  };
}
