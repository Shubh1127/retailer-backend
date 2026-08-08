/**
 * Supplier catalog import.
 *
 * Some suppliers can hand you (or you can pull) a product table with
 * Name + Size + SKU + EAN — the mapping goldmine. This ingests such a table
 * (markdown pipe-table or CSV) into confirmed matches keyed by the unit EAN,
 * with a direct product URL derived from the SKU. No searching needed: this IS
 * the map for that supplier.
 *
 * Prices are NOT in a catalog dump — they come from the refresh step (hit the
 * stored SKU URL). This builds the durable article↔EAN↔SKU↔URL map.
 */

import type { CanonicalProduct, ProductMatch } from '../types.js';
import { connectorFor } from '../connectors/index.js';
import { parseSizeText } from '../connectors/types.js';

export interface CatalogRow {
  name: string;
  size: string;
  sku: string;
  ean: string;
}

export interface CatalogImportResult {
  products: CanonicalProduct[];
  matches: ProductMatch[];
  skipped: { row: number; reason: string }[];
}

/** Normalize a supplier-provided EAN to a 14-digit GTIN key (pad, don't reject:
 *  catalog data is authoritative, and some rows carry 13- or 14-digit codes). */
export function catalogEanToGtin14(ean: string): string | null {
  const digits = ean.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  return digits.padStart(14, '0');
}

/** Parse a markdown pipe-table OR CSV with headers containing name/size/sku/ean. */
export function parseCatalogTable(text: string): CatalogRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: CatalogRow[] = [];
  let cols: { name: number; size: number; sku: number; ean: number } | null = null;

  for (const line of lines) {
    // Split on '|' (markdown) or ',' (csv).
    const cells = line.includes('|')
      ? line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      : line.split(',').map((c) => c.trim());
    if (cells.every((c) => /^-{2,}:?$|^:?-{2,}$|^:?-+:?$/.test(c) || c === '')) continue; // md separator row

    const lower = cells.map((c) => c.toLowerCase());
    if (!cols) {
      const find = (...keys: string[]) => lower.findIndex((c) => keys.some((k) => c.includes(k)));
      const name = find('product name', 'name', 'description');
      const size = find('size', 'pack');
      const sku = find('sku', 'code');
      const ean = find('ean', 'barcode');
      if (name >= 0 && sku >= 0 && ean >= 0) {
        cols = { name, size, sku, ean };
        continue;
      }
      continue; // header not found yet
    }

    const name = cells[cols.name] ?? '';
    const sku = cells[cols.sku] ?? '';
    const ean = cells[cols.ean] ?? '';
    const size = cols.size >= 0 ? cells[cols.size] ?? '' : '';
    if (!sku || !ean || !name) continue; // skip stray/blank rows
    if (/^\d+$/.test(cells[0] ?? '') && cells.length > 4) {
      // Row may lead with a '#' index column; the mapped indices already account
      // for it because the header was parsed the same way.
    }
    rows.push({ name, size, sku, ean });
  }
  return rows;
}

/** Coverage stats for the shared catalog map (per supplier). */
export interface CatalogStats {
  totalMatches: number;
  uniqueEans: number;
  bySupplier: { supplierId: string; matches: number; withUrl: number }[];
}

export function catalogStats(matches: ProductMatch[]): CatalogStats {
  const bySup = new Map<string, { matches: number; withUrl: number }>();
  const eans = new Set<string>();
  for (const m of matches) {
    eans.add(m.unitGtin);
    const s = bySup.get(m.supplierId) ?? { matches: 0, withUrl: 0 };
    s.matches++;
    if (m.productUrl) s.withUrl++;
    bySup.set(m.supplierId, s);
  }
  return {
    totalMatches: matches.length,
    uniqueEans: eans.size,
    bySupplier: [...bySup.entries()].map(([supplierId, v]) => ({ supplierId, ...v })),
  };
}

/** Build products + matches for one supplier from catalog rows. */
export function importSupplierCatalog(rows: CatalogRow[], supplierId: string): CatalogImportResult {
  const connector = connectorFor(supplierId);
  const products = new Map<string, CanonicalProduct>();
  const matches: ProductMatch[] = [];
  const skipped: CatalogImportResult['skipped'] = [];

  rows.forEach((r, i) => {
    const gtin = catalogEanToGtin14(r.ean);
    if (!gtin) {
      skipped.push({ row: i + 1, reason: `Unparseable EAN "${r.ean}"` });
      return;
    }
    const pack = parseSizeText(r.size);
    if (!products.has(gtin)) {
      products.set(gtin, { unitGtin: gtin, name: r.name, brand: '', isPmp: false, isOwnBrand: false });
    }
    const match: ProductMatch = {
      unitGtin: gtin,
      supplierId,
      supplierSku: r.sku,
      supplierDescription: r.name,
      caseConfig: { ...pack, isCatchWeight: false },
      provenance: 'ean_exact', // the supplier's own catalog EAN — exact
      confidence: 1,
      isPmp: false,
      isOwnBrand: false,
      ...(connector?.productUrl ? { productUrl: connector.productUrl(r.sku) } : {}),
    };
    matches.push(match);
  });

  return { products: [...products.values()], matches, skipped };
}
