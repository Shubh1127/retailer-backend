/**
 * Core domain types for the cross-supplier ordering assistant.
 *
 * Design notes (from the approved plan):
 *  - Prices are always normalized to EX-VAT price-per-base-unit before comparison.
 *  - A retail unit EAN is NOT the same number as a wholesale case GTIN, so product
 *    identity lives in a matching table keyed by the normalized unit GTIN-14.
 *  - Only human-confirmed / invoice-seeded matches may influence allocation.
 *  - PMP (price-marked pack) and own-brand are hard constraints: never auto-matched
 *    across those boundaries.
 */

/** Unit of measure for a base unit used in price-per-base-unit comparisons. */
export type Uom = 'each' | 'ml' | 'l' | 'g' | 'kg';

/** How a confirmed match got into the table — drives trust and auditability. */
export type MatchProvenance =
  | 'invoice' // seeded from the user's own invoice/order-history export (exact SKU)
  | 'ean_exact' // supplier page exposed the same unit EAN
  | 'human_confirmed' // user tapped confirm in the app
  | 'llm_suggested'; // candidate only — NOT allocatable until confirmed

/** The final channel used to place an order with a supplier. */
export type FulfilmentChannel =
  | 'quick-order-paste' // supported SKU-list / barcode bulk box (e.g. Musgrave Quick Order)
  | 'csv-upload'
  | 'webview-cart' // synthetic add-to-cart in a user-driven WebView (last resort)
  | 'pick-list-only'; // no automatable path — app emits a formatted order the user keys/emails

/** A cash & carry supplier the shop holds a trade account with. */
export interface Supplier {
  id: string;
  name: string;
  /** The preferred/main supplier wins ties and differences inside the preference band. */
  isMain: boolean;
  /**
   * Ranked buying preference: 1 = first-preference (main), 2 = second, etc.
   * Allocation anchors each line on the MOST-preferred (lowest-rank) supplier that
   * stocks it, and only diverts to a cheaper supplier that beats that anchor by more
   * than the cheaper supplier's own threshold. When unset, rank is derived from
   * isMain (main → 1) then array order, so existing data keeps working.
   */
  preferenceRank?: number;
  channel: FulfilmentChannel;
  /** Minimum order value (ex-VAT) for the supplier to accept/deliver an order. */
  minOrderValue: number;
  /** Order value (ex-VAT) at/above which delivery is free. Omit if N/A. */
  freeDeliveryThreshold?: number;
  /** Flat delivery fee charged below the free-delivery threshold. */
  deliveryFee: number;
  /**
   * Optional per-supplier price adjustment as a fraction (e.g. -0.03 = 3% retro
   * rebate makes this supplier's effective price 3% lower). Defaults to 0 (off).
   */
  priceAdjustmentPct?: number;
  /**
   * Optional per-supplier "compare threshold" as a fraction (e.g. 0.10 = 10%).
   * Mirrors the existing app's per-supplier threshold (Musgrave 10%, others 13%):
   * this supplier only wins a line off the main supplier if it beats main by MORE
   * than its own threshold. Falls back to the global `preferenceBand` when unset.
   */
  thresholdPct?: number;
}

/** Per-supplier packaging config for a product — how a case maps to base units. */
export interface CaseConfig {
  /** Units per case as sold by this supplier (e.g. 24). */
  unitsPerCase: number;
  /** Size of one unit in `uom` (e.g. 330 for a 330ml can). */
  unitSize: number;
  uom: Uom;
  /** Variable-weight lines cannot be compared per-base-unit → excluded from auto-allocation. */
  isCatchWeight: boolean;
}

/**
 * A confirmed link from a canonical product (unit GTIN-14) to a supplier's SKU.
 * Rows with provenance 'llm_suggested' are candidates only and must be filtered
 * out of allocation until a human confirms them.
 */
export interface ProductMatch {
  /** Normalized 14-digit GTIN of the canonical retail unit. */
  unitGtin: string;
  supplierId: string;
  /** The supplier's own product/SKU code used in their bulk-order box. */
  supplierSku: string;
  /** Human-readable supplier description (for the confirmation UI). */
  supplierDescription: string;
  caseConfig: CaseConfig;
  provenance: MatchProvenance;
  /** 0..1 confidence; exact/invoice/human are 1, llm suggestions lower. */
  confidence: number;
  /** Price-marked pack flag — must match across a link. */
  isPmp: boolean;
  /** Own-brand flag — must match across a link. */
  isOwnBrand: boolean;
  /**
   * The product-page URL observed at discovery time. Preferred for refresh
   * (observed beats constructed — e.g. Musgrave URLs embed a slug we can't
   * derive from the SKU). The SKU stays the stable key; if this URL rots, the
   * plan falls back to a constructed URL, then to EAN re-discovery.
   */
  productUrl?: string;
  /** Stable row id (assigned on persist) — used by the mappings cockpit. */
  id?: string;
  /** Which pack to order when a supplier has several matches for one EAN (§15). */
  isPreferred?: boolean;
  /** Operational visibility (v2). */
  lastSuccessfulRefreshAt?: string;
  lastError?: string;
  /** Human-confirmed in the mappings cockpit. */
  confirmed?: boolean;
}

/** A price observed for a supplier SKU, as captured from the portal/price file. */
export interface PriceQuote {
  supplierId: string;
  supplierSku: string;
  /** The price exactly as displayed, per CASE, in the currency shown. */
  rawCasePrice: number;
  /** Whether `rawCasePrice` includes VAT (portals differ). */
  priceIsVatInclusive: boolean;
  /** VAT rate as a fraction (e.g. 0.23). Required to normalize to ex-VAT. */
  vatRate: number;
  isPromo: boolean;
  /** ISO date (YYYY-MM-DD) the promo ends, if any. */
  promoEndDate?: string;
  /** ISO datetime the price was captured. */
  capturedAt: string;
}

/** A canonical product the shop can order (keyed by unit GTIN). */
export interface CanonicalProduct {
  unitGtin: string;
  name: string;
  brand: string;
  isPmp: boolean;
  isOwnBrand: boolean;
}

/** A line the shop owner wants to order this week. */
export interface OrderRequestLine {
  unitGtin: string;
  /** Quantity in CASES to order. */
  cases: number;
}

/** Allocation thresholds — the owner's 5% / 10% rule, configurable per category. */
export interface AllocationConfig {
  /**
   * Preference band as a fraction. The main supplier keeps a line unless another
   * supplier is cheaper by MORE than this fraction. e.g. 0.05 = 5%.
   */
  preferenceBand: number;
  /** Planned order/delivery date (ISO YYYY-MM-DD) — promos ending before it don't count. */
  orderDate: string;
  /**
   * Tolerance for the outlier sanity check. An implied per-base-unit price that
   * deviates from the cross-supplier median by more than this fraction is flagged
   * as a probable parse error and NOT used for routing. e.g. 0.45 = 45%.
   */
  outlierDeviation: number;
}
