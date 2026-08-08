/**
 * Supplier connectors.
 *
 * A connector knows, for one supplier, how to (a) build the URL to search by EAN,
 * (b) build a product URL, and (c) normalize a product-card's fields into our
 * domain records (a canonical product, a confirmed match, and a price quote).
 *
 * IMPORTANT: connectors do NOT fetch. Fetching happens on-device, inside the
 * user's logged-in WebView on the shop LAN (prices are login-gated and the sites
 * run bot management). The WebView extracts the card fields from the DOM and
 * hands them here as a `SearchCard`; the connector turns them into typed data.
 * This keeps the network/credential surface on the device and the parsing logic
 * unit-testable on the server.
 */

import type { CanonicalProduct, PriceQuote, ProductMatch, Uom } from '../types.js';

/** Raw fields pulled from a supplier search-result card by the on-device layer.
 *  Some suppliers give a combined "12 x 70 g" (sizeText); others expose the pack
 *  count and unit size separately (Barry: Size "70g", Pack Qty 12). Provide
 *  whichever the site shows — normalization prefers the structured fields. */
export interface SearchCard {
  supplierSku: string;
  name: string;
  brand?: string;
  /** Combined pack text, e.g. "12 x 70 g", "24 X 330ml". */
  sizeText?: string;
  /** Structured pack fields when the site exposes them separately. */
  unitsPerCase?: number;
  unitSize?: number;
  uom?: Uom;
  /** Displayed case price, e.g. "€16.99". */
  priceText: string;
  /** True if the case price already includes VAT (most trade prices are ex-VAT). */
  priceIncludesVat?: boolean;
  rrpText?: string;
  vatText?: string; // e.g. "0.0%", "23%"
  isPmp?: boolean;
  isOwnBrand?: boolean;
  /** Absolute product-page URL, when the card links to one. */
  productUrl?: string;

  /**
   * Absolute product thumbnail, when the supplier publishes one.
   *
   * Optional on purpose and forever: suppliers differ in whether they expose an
   * image at all, and a missing picture must render as a row without one rather
   * than as a broken image. Nothing downstream may treat this as required.
   *
   * Always absolute by the time it lands here — see `absoluteUrl`. A relative
   * path is meaningless to the browser that eventually renders it, and
   * resolving it at render time would mean the UI having to know each
   * supplier's host.
   */
  imageUrl?: string;

  /**
   * The EAN shown on the page (both Musgrave and Barry display it). REQUIRED
   * for a refresh via stored URL to be trusted: the page EAN must equal the
   * expected EAN, otherwise the result is rejected and the item re-discovered.
   */
  eanText?: string;
}

export interface NormalizedCard {
  product: CanonicalProduct;
  match: ProductMatch;
  quote: PriceQuote;
}

export interface SupplierConnector {
  supplierId: string;
  /** URL to search the supplier for a unit EAN (exact match once an EAN is known). */
  searchUrlByEan(ean: string): string;
  /**
   * URL to search the supplier by product description/name. This is the FIRST
   * discovery step from an EPOS listing, which has no EAN — search the
   * description, confirm the product, and capture its EAN for all future refreshes.
   */
  searchUrlByText(query: string): string;
  /** Build a product-page URL from the supplier's own code, when possible. */
  productUrl?(supplierSku: string): string;
  /**
   * True when `searchUrlByEan`/`searchUrlByText` are real addressable GET URLs
   * (navigating to them == a human typing + Enter). When false, the search box
   * must be driven by typing — use `searchFormJS`.
   */
  searchIsUrlAddressable: boolean;
  /**
   * For sites whose search is a form POST (not a GET URL): JS that fills the
   * search box with `query` and submits it — replicating a real user typing.
   * The on-device WebView runs this instead of navigating to a URL.
   */
  searchFormJS?(query: string): string;
  /** Normalize a card into typed records, keyed by the canonical unit GTIN. */
  normalize(card: SearchCard, ctx: { unitGtin: string; capturedAt: string }): NormalizedCard;
}

/** Trim an EPOS description into a supplier-search-friendly query. Drops trailing
 *  pack noise and collapses whitespace so "SMARTIES HEXATUBE   " → "SMARTIES HEXATUBE". */
export function cleanSearchQuery(description: string): string {
  return description
    .replace(/\s+/g, ' ')
    .replace(/\s*\b(CASE|CS|PMP|PM|EA|EACH)\b\s*$/i, '')
    .trim();
}

/** Shared normalization used by every connector. */
export function normalizeCard(
  card: SearchCard,
  ctx: { unitGtin: string; capturedAt: string; supplierId: string },
): NormalizedCard {
  const pack =
    card.unitsPerCase && card.unitSize
      ? { unitsPerCase: card.unitsPerCase, unitSize: card.unitSize, uom: card.uom ?? 'each' }
      : parseSizeText(card.sizeText ?? '');
  const vatRate = parsePercent(card.vatText);
  const casePrice = parseMoney(card.priceText);

  const product: CanonicalProduct = {
    unitGtin: ctx.unitGtin,
    name: card.name,
    brand: card.brand ?? '',
    isPmp: card.isPmp ?? false,
    isOwnBrand: card.isOwnBrand ?? false,
  };
  const match: ProductMatch = {
    unitGtin: ctx.unitGtin,
    supplierId: ctx.supplierId,
    supplierSku: card.supplierSku,
    supplierDescription: card.name,
    caseConfig: { ...pack, isCatchWeight: false },
    provenance: 'ean_exact', // found by searching the exact EAN
    confidence: 1,
    isPmp: card.isPmp ?? false,
    isOwnBrand: card.isOwnBrand ?? false,
    // Remember where we found it — refresh goes straight back to this page.
    ...(card.productUrl ? { productUrl: card.productUrl } : {}),
  };
  const quote: PriceQuote = {
    supplierId: ctx.supplierId,
    supplierSku: card.supplierSku,
    rawCasePrice: casePrice,
    priceIsVatInclusive: card.priceIncludesVat ?? false,
    vatRate,
    isPromo: false,
    capturedAt: ctx.capturedAt,
  };
  return { product, match, quote };
}

// ---- shared parsing helpers (used by concrete connectors) ----

/**
 * Turn whatever a supplier gave us into an absolute URL, or nothing.
 *
 * Suppliers are inconsistent about this in all three of the usual ways: a full
 * `https://…`, a protocol-relative `//cdn.host/x.jpg`, or a site-relative
 * `/media/x.jpg`. Each is correct on the supplier's own page and only the first
 * survives being handed to a different origin, so they are normalized here
 * rather than at the five call sites that would otherwise each get it slightly
 * wrong.
 *
 * Returns `undefined` rather than throwing on junk: an unparseable image URL is
 * a missing picture, which every caller already handles, and must never be able
 * to fail a supplier search that is otherwise fine.
 */
export function absoluteUrl(
  value: string | undefined,
  base: string,
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  // Upgraded to https, ALWAYS, and not just for the one host known to support
  // it. These URLs are rendered on an https page, where a browser blocks every
  // http subresource outright — so a plain-http image never loads regardless.
  // Upgrading cannot be worse than that: a host without TLS fails to load,
  // which is exactly what mixed-content blocking already does. Hardcoding the
  // hostnames that support https would go stale the day a supplier adds
  // another image server.
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'https://');
  // Protocol-relative: already absolute apart from the scheme.
  if (raw.startsWith('//')) return `https:${raw}`;

  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

/** "€16.99" | "16,99" | "£1,234.50" → 16.99 / 1234.5. */
export function parseMoney(text: string): number {
  const m = text.replace(/\s/g, '').match(/([\d.,]+)/);
  if (!m) return NaN;
  let s = m[1]!;
  // If both separators present, assume ',' thousands and '.' decimal.
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.'); // european decimal
  return Number(s);
}

/** "0.0%" | "23%" → 0 / 0.23. */
export function parsePercent(text: string | undefined): number {
  if (!text) return 0;
  const m = text.match(/([\d.]+)/);
  return m ? Number(m[1]) / 100 : 0;
}

function toUom(
  rawUom: string,
  unitSize: number,
): { uom: Uom; unitSize: number } {
  const u = rawUom.toLowerCase();

  if (u.startsWith("kg")) {
    return { uom: "kg", unitSize };
  }

  if (u === "g" || u.startsWith("gr")) {
    return { uom: "g", unitSize };
  }

  if (u.startsWith("ml")) {
    return { uom: "ml", unitSize };
  }

  if (u === "cl") {
    return {
      uom: "ml",
      unitSize: unitSize * 10,
    };
  }

  if (u === "l" || u.startsWith("ltr") || u.startsWith("lt")) {
    return { uom: "l", unitSize };
  }

  return {
    uom: "each",
    unitSize,
  };
}

/**
 * Parse pack text into { unitsPerCase, unitSize, uom }. Handles both common
 * layouts: pack-first "12 x 70 g" / "24 X 330ml" (Musgrave), and unit-first
 * "70g / 12" (Barry Group list rows).
 */
export function parseSizeText(text: string): { unitsPerCase: number; unitSize: number; uom: Uom } {
  const t = text.trim();
  // Pack-first: "12 x 70 g"
  const packFirst = t.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/);
  if (packFirst) {
    const { uom, unitSize } = toUom(packFirst[3] ?? '', Number(packFirst[2]));
    return { unitsPerCase: Number(packFirst[1]), unitSize, uom };
  }
  // Unit-first: "70g / 12"
  const unitFirst = t.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*\/\s*(\d+)/);
  if (unitFirst) {
    const { uom, unitSize } = toUom(unitFirst[2] ?? '', Number(unitFirst[1]));
    return { unitsPerCase: Number(unitFirst[3]), unitSize, uom };
  }
  return { unitsPerCase: 1, unitSize: 1, uom: 'each' };
}
