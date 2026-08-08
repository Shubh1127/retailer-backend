/**
 * EPOS "Article Order Listing" importer.
 *
 * This is the REAL input the shop starts from: an Excel export from the till/EPOS
 * system (Musgrave/Centra "Article Order Listing"). Structure observed in real
 * files:
 *   - A few title rows (store name, print date, "Article Order Listing").
 *   - A header row with: Article | Description | Pack | Size | Quantity | Cost.
 *   - Rows grouped under DEPARTMENT / SUB-DEPARTMENT section headings.
 *   - Data rows keyed by an internal Article code like `01019335\2`
 *     (NOT a barcode — there is no EAN in this export), a description that may
 *     carry leading flag characters (`#`, `=`, `*`), a "24 X 38.000" pack/size,
 *     a quantity, and a Cost (the shop's current/"Main" cost).
 *
 * Because there is no barcode, cross-supplier identity is by description + pack
 * size (matched against each supplier's catalogue), exactly as the existing app
 * does. The Article code is the shop-side canonical key; we carry the Cost as the
 * savings baseline ("Main").
 *
 * Reads .xls and .xlsx via SheetJS.
 */

import * as XLSX from 'xlsx';

export interface ShopArticle {
  /** Internal EPOS article code, e.g. "01019335\\2". Canonical shop-side key. */
  articleCode: string;
  /**
   * 1-based row number in the source sheet — the number Excel shows in its row
   * gutter. Carried so a match (or a miss) can be pointed back at the exact line
   * of the file the shop uploaded.
   */
  sourceRow: number;
  /** Description as exported, before the leading `#`/`=`/`*` flags are stripped. */
  descriptionRaw: string;
  description: string;
  /** Raw pack/size text as exported, e.g. "24 X 38.000". */
  packRaw: string;
  /** Parsed units per case (e.g. 24) when the pack text is "N X M". */
  unitsPerCase?: number;
  /** Parsed unit size (e.g. 38) when present. Uom is not in this export. */
  unitSize?: number;
  /** Quantity of cases to order (defaults to 1). */
  cases: number;
  /** Current / main cost per case — the savings baseline. */
  mainCost?: number;
  department?: string;
  subDepartment?: string;
}

export interface EposImportResult {
  storeName?: string;
  articles: ShopArticle[];
  /** Rows that looked like data but couldn't be parsed. */
  skipped: { row: number; reason: string }[];
}

const CODE_RE = /^\d+\\\d+$/; // e.g. 01019335\2
const PACK_RE = /^\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/; // "24 X 38.000"
/** Leading flag characters some EPOS exports prefix onto the description. */
const DESC_FLAGS_RE = /^[#=*+~\s]+/;

/** Locate the header row (has "Article" and "Description"). Returns its index or -1. */
function findHeaderRow(rows: unknown[][]): number {
  // Blank rows are retained (see `importEposListing`) so the scan window has to be
  // wide enough to clear the spacer rows real exports put above the header.
  for (let r = 0; r < Math.min(rows.length, 100); r++) {
    const cells = (rows[r] ?? []).map((c) => String(c ?? '').trim().toLowerCase());
    if (cells.includes('article') && cells.includes('description')) return r;
  }
  return -1;
}

/** Column index of the first cell whose header matches any candidate label. */
function colOf(header: unknown[], candidates: string[]): number {
  const norm = header.map((c) => String(c ?? '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = norm.indexOf(cand);
    if (i >= 0) return i;
  }
  return -1;
}

function toNumber(v: unknown): number | undefined {
  if (v === '' || v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[£$,]/g, '').trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse an EPOS Article Order Listing workbook (as a Buffer/Uint8Array or base64
 * string) into shop articles. `defaultCases` sets the order quantity when the
 * sheet's Quantity is blank/zero.
 */
export function importEposListing(
  input: ArrayBuffer | Uint8Array | Buffer | string,
  opts: { defaultCases?: number } = {},
): EposImportResult {
  const wb =
    typeof input === 'string'
      ? XLSX.read(input, { type: 'base64' })
      : XLSX.read(input, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  // `blankrows: true` keeps the array index aligned with the sheet's own rows, so
  // every article can report the row number Excel shows. Blank rows carry no
  // article code and are skipped by the same test that skips section headings.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true, raw: true });

  // A sheet whose used range does not start at row 1 shifts every index.
  const ref = sheet['!ref'];
  const firstSheetRow = ref ? XLSX.utils.decode_range(ref).s.r : 0;
  /** Array index → the 1-based row number Excel displays. */
  const excelRow = (index: number) => firstSheetRow + index + 1;

  const storeName = rows[0]?.[0] ? String(rows[0][0]).trim() : undefined;
  const headerRow = findHeaderRow(rows);
  if (headerRow < 0) {
    return { articles: [], skipped: [{ row: 0, reason: 'No header row (Article/Description) found' }], ...(storeName ? { storeName } : {}) };
  }
  const header = rows[headerRow] ?? [];

  // Data columns. Article/Description/Quantity/Cost sit under their labels; the
  // "Pack"/"Size" labels and the actual "24 X 38.000" value can be offset a few
  // columns, so resolve Pack/Size by scanning the first data row for the pattern.
  const cArticle = colOf(header, ['article']);
  const cDesc = colOf(header, ['description']);
  const cQty = colOf(header, ['quantity', 'qty']);
  const cCost = colOf(header, ['cost', 'price']);

  const articles: ShopArticle[] = [];
  const skipped: EposImportResult['skipped'] = [];
  let department: string | undefined;
  let subDepartment: string | undefined;
  let cPack = -1;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const code = String(row[cArticle] ?? '').trim();
    const desc = String(row[cDesc] ?? '').trim();

    if (!CODE_RE.test(code)) {
      // Section heading (department / sub-department) or noise. Track headings.
      if (code && !desc) {
        if (!department) department = code;
        else subDepartment = code;
      }
      continue;
    }

    // Resolve the pack column once, from the first data row that has an "N x M".
    if (cPack < 0) {
      for (let c = 0; c < row.length; c++) {
        if (PACK_RE.test(String(row[c] ?? ''))) { cPack = c; break; }
      }
    }
    const packRaw = cPack >= 0 ? String(row[cPack] ?? '').trim() : '';
    const m = packRaw.match(PACK_RE);
    const qty = toNumber(row[cQty]);
    const cost = toNumber(row[cCost]);

    const article: ShopArticle = {
      articleCode: code,
      sourceRow: excelRow(r),
      descriptionRaw: desc,
      description: desc.replace(DESC_FLAGS_RE, '').trim(),
      packRaw,
      cases: qty && qty > 0 ? Math.round(qty) : (opts.defaultCases ?? 1),
      ...(m ? { unitsPerCase: Number(m[1]), unitSize: Number(m[2]) } : {}),
      ...(cost !== undefined ? { mainCost: cost } : {}),
      ...(department ? { department } : {}),
      ...(subDepartment ? { subDepartment } : {}),
    };
    articles.push(article);
  }

  return { articles, skipped, ...(storeName ? { storeName } : {}) };
}
