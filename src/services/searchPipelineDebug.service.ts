/**
 * Search-pipeline debug mode.
 *
 * Answers one question, for one uploaded Excel/CSV file: **what exactly does each
 * row of this file turn into by the time it reaches a supplier's search API?**
 *
 * It traces the real path a product takes —
 *
 *   sheet row → importEposListing → ShopArticle → cleanSearchQuery → supplier params
 *
 * — and reports every stage, including the rows that never became a product at
 * all. The supplier request shapes come from the supplier services' own exported
 * builders (`buildMusgraveSearchUrl`, `buildOreillySearchUrl`), not from copies
 * kept here, so what this prints cannot drift from what is actually transmitted.
 *
 * Read-only and offline: nothing is fetched, nothing is written, and the
 * production order flow does not call into this file. The one optional network
 * call is a Musgrave login (`resolveSpgid`), used only to substitute the real
 * `spgid` into the displayed URL instead of a placeholder.
 */

import * as XLSX from 'xlsx';

import { importEposListing, type ShopArticle } from '../ingest/eposListing.js';
import { cleanSearchQuery } from '../connectors/types.js';
import {
  buildMusgraveSearchParams,
  buildMusgraveSearchUrl,
  MUSGRAVE_SEARCH_PARAM,
} from './musgrave.service.js';
import {
  buildOreillySearchParams,
  buildOreillySearchUrl,
  OREILLY_SEARCH_PARAM,
  OREILLY_SEARCH_URL,
} from './oreilly.service.js';
import { SUPPLIERS } from './supplierSearch.js';

/** Stands in for the personalization group id when no session was resolved. */
export const SPGID_PLACEHOLDER = '{spgid}';

/** One named step in turning a sheet cell into a supplier query. */
export interface QueryStage {
  stage: string;
  /** What the text looks like after this step. */
  value: string;
  /** What the step did, and where it lives. */
  by: string;
}

/** Exactly what one supplier receives for one product. */
export interface SupplierQueryTrace {
  supplierId: string;
  supplierName: string;
  /** THE string sent as the search term. This is the headline field. */
  searchString: string;
  /** The request parameter it travels in. */
  parameter: string;
  method: 'GET';
  endpoint: string;
  /** Fully-resolved request URL, query string included. */
  url: string;
  /** Every parameter sent alongside the search term. */
  params: Record<string, string>;
  /** Set when the request could not be shown exactly (e.g. unresolved session). */
  note?: string;
}

/**
 * Product attributes the pipeline has in hand at search time. `absent` names the
 * fields that are read about but not actually extracted from the file today —
 * the point of a debug mode is to make those gaps visible rather than imply a
 * value of `undefined` means "this row had none".
 */
export interface ExtractedFields {
  brand?: string;
  packRaw?: string;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: string;
  quantityCases?: number;
  mainCost?: number;
  department?: string;
  subDepartment?: string;
  /** Fields the importer never populates, with the reason. */
  absent: { field: string; reason: string }[];
}

/** Everything known about one row of the uploaded file. */
export interface RowTrace {
  /** 1-based row number as Excel displays it. */
  excelRow: number;
  /** The description cell exactly as it appears in the file. */
  originalDescription: string;
  /** The parsed product, or null when this row produced none. */
  parsedProduct: ShopArticle | null;
  /** Why no product exists, when `parsedProduct` is null. */
  noProductReason?: string;
  /** The text transformations, in order, from cell to search string. */
  queryStages: QueryStage[];
  /** What each supplier is sent. Empty when the row produced no product. */
  suppliers: SupplierQueryTrace[];
  extracted?: ExtractedFields;
  /** True when Musgrave and O'Reilly receive byte-identical search strings. */
  suppliersShareQuery: boolean;
}

export interface SearchPipelineDebugReport {
  file: string;
  storeName?: string;
  /** Rows in the sheet's used range. */
  sheetRows: number;
  /** Rows that parsed into a product. */
  productRows: number;
  /** Rows traced in this report (after `--limit` / `--row`). */
  tracedRows: number;
  /** Whether the Musgrave URLs carry a real spgid or the placeholder. */
  spgid: string;
  rows: RowTrace[];
  /** Distinct observations about the pipeline, gathered across all rows. */
  observations: string[];
}

export interface SearchPipelineDebugOptions {
  /** Trace only the first N rows that produced a product. */
  limit?: number;
  /** Trace only this Excel row number. */
  onlyRow?: number;
  /** Include rows that produced no product (headings, blanks, titles). */
  includeNonProductRows?: boolean;
  /** Order quantity when the sheet's Quantity cell is blank — mirrors the real run. */
  defaultCases?: number;
  /** Real personalization group id, when one was resolved. */
  spgid?: string;
  /** Label for the report header. */
  fileLabel?: string;
}

/** Fields the EPOS export simply does not carry, with why. */
const ABSENT_FIELDS: { field: string; reason: string }[] = [
  {
    field: 'brand',
    reason:
      'not extracted — the EPOS export has no brand column, and the importer does not split one out of the description',
  },
  {
    field: 'uom',
    reason: 'not extracted — the "24 X 38.000" pack text states no unit (g/ml/each)',
  },
  {
    field: 'ean / barcode',
    reason: 'not present — this export carries only the internal article code',
  },
];

const CODE_RE = /^\d+\\\d+$/;

/** Read the sheet as raw rows, index-aligned with the row numbers Excel shows. */
function readSheetRows(
  input: ArrayBuffer | Uint8Array | Buffer | string,
): { rows: unknown[][]; firstSheetRow: number } {
  const wb =
    typeof input === 'string'
      ? XLSX.read(input, { type: 'base64' })
      : XLSX.read(input, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) return { rows: [], firstSheetRow: 0 };

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: true,
    raw: true,
  });
  const ref = sheet['!ref'];
  return { rows, firstSheetRow: ref ? XLSX.utils.decode_range(ref).s.r : 0 };
}

/** Best-effort description text for a row the importer rejected. */
function rowText(row: unknown[]): string {
  return row
    .map((c) => String(c ?? '').trim())
    .filter(Boolean)
    .join(' | ');
}

/** Why a row produced no product. Mirrors the importer's own skip conditions. */
function classifyNonProductRow(row: unknown[]): string {
  const cells = row.map((c) => String(c ?? '').trim());
  if (cells.every((c) => c === '')) return 'blank row';

  const lower = cells.map((c) => c.toLowerCase());
  if (lower.includes('article') && lower.includes('description')) return 'header row';

  const first = cells.find(Boolean) ?? '';
  if (CODE_RE.test(first)) return 'has an article code but was not parsed';

  // The importer treats a lone non-code value as a department / sub-department.
  const filled = cells.filter(Boolean);
  if (filled.length === 1) return 'section heading (department / sub-department)';

  return 'no article code in the Article column — title or note row';
}

function extractedFrom(article: ShopArticle): ExtractedFields {
  return {
    ...(article.packRaw ? { packRaw: article.packRaw } : {}),
    ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    quantityCases: article.cases,
    ...(article.mainCost !== undefined ? { mainCost: article.mainCost } : {}),
    ...(article.department ? { department: article.department } : {}),
    ...(article.subDepartment ? { subDepartment: article.subDepartment } : {}),
    absent: ABSENT_FIELDS,
  };
}

/**
 * The supplier requests one search string produces.
 *
 * Both suppliers get the SAME string: `orderFile.service.ts` and
 * `bulkSearchProbe.service.ts` call `cleanSearchQuery` once per article and hand
 * the result to `searchAllSuppliers`, which fans it out unchanged.
 */
export function supplierTraces(query: string, spgid: string): SupplierQueryTrace[] {
  const musgraveParams = Object.fromEntries(buildMusgraveSearchParams(query));
  const oreillyParams = buildOreillySearchParams(query);

  return [
    {
      supplierId: 'musgrave',
      supplierName: SUPPLIERS.get('musgrave')?.name ?? 'Musgrave',
      searchString: query,
      parameter: MUSGRAVE_SEARCH_PARAM,
      method: 'GET',
      endpoint: 'Intershop REST /products',
      url: buildMusgraveSearchUrl(query, spgid),
      params: musgraveParams,
      ...(spgid === SPGID_PLACEHOLDER
        ? { note: 'spgid is a placeholder — pass --resolve-session to log in and show the real one' }
        : {}),
    },
    {
      supplierId: 'oreilly',
      supplierName: SUPPLIERS.get('oreilly')?.name ?? "O'Reilly",
      searchString: query,
      parameter: OREILLY_SEARCH_PARAM,
      method: 'GET',
      endpoint: OREILLY_SEARCH_URL,
      url: buildOreillySearchUrl(query),
      params: oreillyParams,
    },
  ];
}

/** The text transformations between the sheet cell and the supplier parameter. */
function queryStages(article: ShopArticle, query: string): QueryStage[] {
  const stages: QueryStage[] = [
    {
      stage: 'sheet cell',
      value: article.descriptionRaw,
      by: 'Description column, as exported',
    },
    {
      stage: 'imported description',
      value: article.description,
      by: 'ingest/eposListing.ts — strips leading #/=/*/+/~ flags, trims',
    },
    {
      stage: 'search string',
      value: query,
      by: 'connectors/types.ts cleanSearchQuery — collapses whitespace, drops a trailing CASE/CS/PMP/PM/EA/EACH',
    },
  ];
  return stages;
}

/** Pipeline-wide notes worth knowing before changing anything. */
function observe(rows: readonly RowTrace[]): string[] {
  const notes: string[] = [];
  const products = rows.filter((r) => r.parsedProduct);
  if (products.length === 0) return notes;

  if (products.every((r) => r.suppliersShareQuery)) {
    notes.push(
      'Both suppliers receive the identical search string — there is no per-supplier query shaping today.',
    );
  }

  const unchanged = products.filter(
    (r) => r.queryStages[0]!.value === r.queryStages.at(-1)!.value,
  ).length;
  notes.push(
    `${unchanged}/${products.length} traced products reach the suppliers as the raw sheet text, unmodified.`,
  );

  const flagged = products.filter(
    (r) => r.queryStages[0]!.value !== r.queryStages[1]!.value,
  ).length;
  if (flagged > 0) {
    notes.push(`${flagged} description(s) had EPOS flag characters stripped by the importer.`);
  }

  const trimmed = products.filter(
    (r) => r.queryStages[1]!.value !== r.queryStages[2]!.value,
  ).length;
  notes.push(
    trimmed > 0
      ? `${trimmed} description(s) were altered by cleanSearchQuery.`
      : 'cleanSearchQuery changed nothing on any traced row — the imported description is sent verbatim.',
  );

  const noPack = products.filter((r) => r.parsedProduct!.unitsPerCase === undefined).length;
  if (noPack > 0) {
    notes.push(
      `${noPack}/${products.length} traced products have no parsed pack size — the "N X M" cell was missing or unreadable.`,
    );
  }

  notes.push(
    'No pack size, quantity or article code is included in either search request; the search term is the description alone.',
  );
  notes.push(
    'No brand is extracted anywhere in this pipeline — brand only ever arrives from the supplier response.',
  );

  return notes;
}

/**
 * Trace an uploaded Excel/CSV order file through the search pipeline without
 * contacting any supplier.
 */
export function debugSearchPipeline(
  input: ArrayBuffer | Uint8Array | Buffer | string,
  opts: SearchPipelineDebugOptions = {},
): SearchPipelineDebugReport {
  const spgid = opts.spgid ?? SPGID_PLACEHOLDER;

  const parsed = importEposListing(
    input,
    opts.defaultCases !== undefined ? { defaultCases: opts.defaultCases } : {},
  );
  const { rows: sheetRows, firstSheetRow } = readSheetRows(input);

  const byRow = new Map<number, ShopArticle>(
    parsed.articles.map((a) => [a.sourceRow, a]),
  );

  const traces: RowTrace[] = [];
  let productsTraced = 0;

  for (let index = 0; index < sheetRows.length; index++) {
    const excelRow = firstSheetRow + index + 1;
    if (opts.onlyRow !== undefined && excelRow !== opts.onlyRow) continue;

    const article = byRow.get(excelRow);

    if (!article) {
      if (!opts.includeNonProductRows) continue;
      const row = sheetRows[index] ?? [];
      traces.push({
        excelRow,
        originalDescription: rowText(row),
        parsedProduct: null,
        noProductReason: classifyNonProductRow(row),
        queryStages: [],
        suppliers: [],
        suppliersShareQuery: false,
      });
      continue;
    }

    if (opts.limit !== undefined && productsTraced >= opts.limit) break;
    productsTraced++;

    const query = cleanSearchQuery(article.description);

    // An empty query is a real outcome: `searchAndScore` returns with no
    // candidates and never contacts a supplier. Show that rather than a request
    // that is not made.
    const suppliers = query ? supplierTraces(query, spgid) : [];

    traces.push({
      excelRow,
      originalDescription: article.descriptionRaw,
      parsedProduct: article,
      ...(query
        ? {}
        : {
            noProductReason:
              'description is empty after cleaning — no supplier search is issued for this line',
          }),
      queryStages: queryStages(article, query),
      extracted: extractedFrom(article),
      suppliers,
      suppliersShareQuery:
        suppliers.length > 1 &&
        new Set(suppliers.map((s) => s.searchString)).size === 1,
    });
  }

  return {
    file: opts.fileLabel ?? '(buffer)',
    sheetRows: sheetRows.length,
    productRows: parsed.articles.length,
    tracedRows: traces.length,
    spgid,
    rows: traces,
    observations: observe(traces),
    ...(parsed.storeName ? { storeName: parsed.storeName } : {}),
  };
}
