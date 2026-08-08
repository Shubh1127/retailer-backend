/**
 * Product-list / order-list import.
 *
 * Lets the owner build the weekly order list from a spreadsheet instead of (or as
 * well as) scanning. Accepts a CSV with a barcode/EAN column and a quantity
 * column; each row becomes an OrderRequestLine keyed by canonical GTIN-14 — the
 * same key the scanner and the matching table use, so imported and scanned lines
 * merge cleanly.
 *
 * This is complementary to `importSupplierFile` (which seeds supplier prices +
 * matches). Here we only care about "what and how many to order".
 */

import { normalizeToGtin14, GtinError } from '../gtin.js';
import { parseCsvRecords } from './csv.js';
import type { OrderRequestLine } from '../types.js';

export interface OrderListMapping {
  /** Column holding the retail barcode/EAN. */
  barcode: string;
  /** Column holding the quantity in CASES. Defaults to 1 when absent/blank. */
  cases?: string;
  /** Optional free-text description column (kept for the review UI). */
  description?: string;
}

export interface OrderListImportResult {
  lines: OrderRequestLine[];
  /** Rows whose barcode could not be normalized (invalid / variable-weight / blank). */
  skipped: { barcode: string; description?: string; reason: string }[];
}

function parseCases(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return 1;
  const n = Number(v.replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return Math.floor(n);
}

/**
 * Parse a product-list CSV into order lines. Duplicate barcodes are merged by
 * summing their case quantities so a spreadsheet with repeated rows behaves like
 * repeated scans.
 */
export function importOrderList(csvText: string, mapping: OrderListMapping): OrderListImportResult {
  const records = parseCsvRecords(csvText);
  const byGtin = new Map<string, number>();
  const skipped: OrderListImportResult['skipped'] = [];

  for (const rec of records) {
    const rawBarcode = (rec[mapping.barcode] ?? '').trim();
    const description = mapping.description ? rec[mapping.description]?.trim() : undefined;
    if (!rawBarcode) {
      skipped.push({ barcode: '', ...(description ? { description } : {}), reason: 'Blank barcode' });
      continue;
    }
    const cases = parseCases(mapping.cases ? rec[mapping.cases] : undefined);
    if (!Number.isFinite(cases)) {
      skipped.push({ barcode: rawBarcode, ...(description ? { description } : {}), reason: 'Bad quantity' });
      continue;
    }
    let gtin: string;
    try {
      gtin = normalizeToGtin14(rawBarcode);
    } catch (e) {
      const reason = e instanceof GtinError ? e.message : String(e);
      skipped.push({ barcode: rawBarcode, ...(description ? { description } : {}), reason });
      continue;
    }
    byGtin.set(gtin, (byGtin.get(gtin) ?? 0) + cases);
  }

  const lines: OrderRequestLine[] = [...byGtin.entries()].map(([unitGtin, cases]) => ({
    unitGtin,
    cases,
  }));
  return { lines, skipped };
}
