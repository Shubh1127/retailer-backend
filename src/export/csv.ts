/**
 * CSV writing — the counterpart to `ingest/csv.ts`, which only parses.
 *
 * Supplier order files are a two-column list: the supplier's OWN product code
 * plus a quantity. The column NAMES differ per supplier and are still being
 * confirmed against each portal's upload form, so they are template-driven
 * rather than hardcoded — a template swap is the only change needed once the
 * real upload format is known.
 *
 * Quoting follows the same RFC 4180 rules `parseCsv` understands (double the
 * quotes, wrap anything containing a comma/quote/newline or edge whitespace)
 * and rows are CRLF-terminated, which is what both portals' upload forms and
 * Excel expect.
 */

export interface CsvTemplate {
  /** Suggested download filename. */
  filename: string;
  /** Header for the column holding the supplier's own product code. */
  skuColumn: string;
  /** Header for the column holding the order quantity in cases. */
  quantityColumn: string;
  /** Emit the header row. Some upload forms want a bare `code,qty` list. */
  includeHeader?: boolean;
}

/**
 * Starting templates. These are a best guess at each portal's expected columns
 * and are deliberately easy to override per request — the upload/Add-to-Cart
 * reverse engineering is happening separately.
 */
export const DEFAULT_CSV_TEMPLATES: Record<string, CsvTemplate> = {
  musgrave: {
    filename: 'musgrave-order.csv',
    skuColumn: 'sku',
    quantityColumn: 'quantity',
    includeHeader: true,
  },
  oreilly: {
    filename: 'oreilly-order.csv',
    skuColumn: 'product_code',
    quantityColumn: 'quantity',
    includeHeader: true,
  },
};

/** Fields needing quotes: separator, quote, newline, or leading/trailing space. */
const NEEDS_QUOTING = /[",\r\n]|^[ \t]|[ \t]$/;

/** Escape a single CSV field. */
export function csvField(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  return NEEDS_QUOTING.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render a header + rows as CSV text. Always CRLF-terminated, including the
 * final line, because some upload forms drop a trailing unterminated row.
 */
export function toCsv(
  headers: string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
  opts: { includeHeader?: boolean } = {},
): string {
  const lines: string[] = [];
  if (opts.includeHeader !== false) lines.push(headers.map(csvField).join(','));
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}

/** One supplier's finished order file. */
export interface SupplierOrderFile {
  supplierId: string;
  filename: string;
  /** The column headers used, in order — echoed so the caller can verify them. */
  columns: string[];
  rowCount: number;
  /** Sum of the quantity column. */
  totalCases: number;
  csv: string;
}

/** A single line destined for a supplier's order file. */
export interface SupplierOrderRow {
  supplierSku: string;
  cases: number;
}

/**
 * Build one supplier's CSV from its awarded rows. Rows sharing a supplier SKU
 * are merged by summing quantities — two EPOS articles can legitimately resolve
 * to the same supplier pack, and sending the code twice would either double the
 * line or be rejected by the portal.
 */
export function buildSupplierOrderFile(
  supplierId: string,
  rows: readonly SupplierOrderRow[],
  template: CsvTemplate,
): SupplierOrderFile {
  const merged = new Map<string, number>();
  for (const row of rows) {
    if (!row.supplierSku) continue; // never emit a blank product code
    merged.set(row.supplierSku, (merged.get(row.supplierSku) ?? 0) + row.cases);
  }

  const columns = [template.skuColumn, template.quantityColumn];
  const body = [...merged.entries()].map(([sku, cases]) => [sku, cases] as const);

  return {
    supplierId,
    filename: template.filename,
    columns,
    rowCount: body.length,
    totalCases: body.reduce((sum, [, cases]) => sum + cases, 0),
    csv: toCsv(columns, body, { includeHeader: template.includeHeader }),
  };
}
