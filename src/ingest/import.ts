/**
 * Import + seeding — the highest-leverage component.
 *
 * A supplier order-history / price-file export (CSV/Excel-as-CSV) is parsed into:
 *   - CanonicalProduct rows (deduped by normalized unit GTIN),
 *   - ProductMatch rows AUTO-CONFIRMED with provenance 'invoice' (the SKU came
 *     straight off the user's own order/invoice — exact, trustworthy),
 *   - PriceQuote rows for comparison.
 *
 * This converts most of the ~500-item setup from a search problem into
 * reconciliation: lines the owner already buys are matched without human effort.
 * Rows without a usable GTIN are returned as `needsReview` (they still create a
 * supplier SKU, but must be matched to a canonical product by hand or by an
 * LLM-suggested candidate that a human confirms).
 */

import { normalizeToGtin14, GtinError } from '../gtin.js';
import { parseCsvRecords } from './csv.js';
import type { CanonicalProduct, PriceQuote, ProductMatch, Uom } from '../types.js';

/** Maps CSV column headers to the fields we need. All keys are header names. */
export interface ColumnMapping {
  supplierSku: string;
  description: string;
  /** Retail unit EAN/barcode column (optional; when absent → needsReview). */
  unitGtin?: string;
  unitsPerCase: string;
  unitSize: string;
  uom: string;
  casePrice: string;
  vatRate?: string;
  priceIsVatInclusive?: string;
  isPromo?: string;
  promoEndDate?: string;
  brand?: string;
  isPmp?: string;
  isOwnBrand?: string;
}

export interface ImportOptions {
  supplierId: string;
  mapping: ColumnMapping;
  /** ISO datetime to stamp on captured prices (pass in — no Date.now in core). */
  capturedAt: string;
  /** Default VAT rate (fraction) when a row has no VAT column. */
  defaultVatRate: number;
  /** Whether prices in this file include VAT (portals differ). */
  pricesVatInclusive: boolean;
}

export interface ImportResult {
  products: CanonicalProduct[];
  matches: ProductMatch[];
  quotes: PriceQuote[];
  /** Rows that parsed but lack a usable GTIN — SKU + price captured, match pending. */
  needsReview: { supplierSku: string; description: string; reason: string }[];
  /** Rows that failed to parse at all. */
  errors: { row: number; reason: string }[];
}

const UOMS: ReadonlySet<string> = new Set(['each', 'ml', 'l', 'g', 'kg']);

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes', 'y', 't'].includes(v.trim().toLowerCase());
}

function parseNum(v: string | undefined): number {
  if (v === undefined) return NaN;
  return Number(v.replace(/[€£$,]/g, '').trim());
}

export function importSupplierFile(csvText: string, opts: ImportOptions): ImportResult {
  const { supplierId, mapping: m } = opts;
  const records = parseCsvRecords(csvText);

  const products = new Map<string, CanonicalProduct>();
  const matches: ProductMatch[] = [];
  const quotes: PriceQuote[] = [];
  const needsReview: ImportResult['needsReview'] = [];
  const errors: ImportResult['errors'] = [];

  records.forEach((rec, idx) => {
    const rowNo = idx + 2; // +1 header, +1 to 1-index
    const supplierSku = rec[m.supplierSku]?.trim();
    const description = rec[m.description]?.trim() ?? '';
    if (!supplierSku) {
      errors.push({ row: rowNo, reason: 'Missing supplier SKU' });
      return;
    }

    const unitsPerCase = parseNum(rec[m.unitsPerCase]);
    const unitSize = parseNum(rec[m.unitSize]);
    const uomRaw = (rec[m.uom] ?? '').trim().toLowerCase();
    const casePrice = parseNum(rec[m.casePrice]);

    if (!Number.isFinite(casePrice) || casePrice < 0) {
      errors.push({ row: rowNo, reason: `Bad case price "${rec[m.casePrice]}"` });
      return;
    }
    if (!UOMS.has(uomRaw)) {
      errors.push({ row: rowNo, reason: `Unknown uom "${rec[m.uom]}"` });
      return;
    }
    if (!Number.isFinite(unitsPerCase) || unitsPerCase <= 0 || !Number.isFinite(unitSize) || unitSize <= 0) {
      errors.push({ row: rowNo, reason: 'Bad units-per-case / unit-size' });
      return;
    }

    const isPmp = parseBool(rec[m.isPmp ?? '']);
    const isOwnBrand = parseBool(rec[m.isOwnBrand ?? '']);
    const isCatchWeight = uomRaw === 'kg' || uomRaw === 'g' ? false : false; // supplier can flag separately
    const vatRate = m.vatRate && rec[m.vatRate] ? parseNum(rec[m.vatRate]) : opts.defaultVatRate;
    const promoEnd = m.promoEndDate ? rec[m.promoEndDate]?.trim() : undefined;

    const quote: PriceQuote = {
      supplierId,
      supplierSku,
      rawCasePrice: casePrice,
      priceIsVatInclusive: m.priceIsVatInclusive
        ? parseBool(rec[m.priceIsVatInclusive])
        : opts.pricesVatInclusive,
      vatRate: Number.isFinite(vatRate) ? vatRate : opts.defaultVatRate,
      isPromo: parseBool(rec[m.isPromo ?? '']),
      capturedAt: opts.capturedAt,
      ...(promoEnd ? { promoEndDate: promoEnd } : {}),
    };
    quotes.push(quote);

    const rawGtin = m.unitGtin ? rec[m.unitGtin]?.trim() : undefined;
    if (!rawGtin) {
      needsReview.push({ supplierSku, description, reason: 'No GTIN column value — match pending' });
      return;
    }
    let gtin: string;
    try {
      gtin = normalizeToGtin14(rawGtin);
    } catch (e) {
      const reason = e instanceof GtinError ? e.message : String(e);
      needsReview.push({ supplierSku, description, reason });
      return;
    }

    if (!products.has(gtin)) {
      products.set(gtin, {
        unitGtin: gtin,
        name: description,
        brand: (m.brand && rec[m.brand]?.trim()) || '',
        isPmp,
        isOwnBrand,
      });
    }

    // Invoice-seeded, auto-confirmed exact match.
    matches.push({
      unitGtin: gtin,
      supplierId,
      supplierSku,
      supplierDescription: description,
      caseConfig: { unitsPerCase, unitSize, uom: uomRaw as Uom, isCatchWeight },
      provenance: 'invoice',
      confidence: 1,
      isPmp,
      isOwnBrand,
    });
  });

  return { products: [...products.values()], matches, quotes, needsReview, errors };
}
