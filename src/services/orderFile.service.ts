/**
 * Supplier order-file preparation.
 *
 *   EPOS file → parse → search suppliers → match → extract SKU → CSV per supplier
 *
 * The whole pipeline is assembled from modules that already exist and are tested;
 * this file is orchestration and bookkeeping only:
 *
 *   importEposListing  (ingest/eposListing.ts)  the ONLY parser
 *   cleanSearchQuery   (connectors/types.ts)    description → supplier query
 *   searchAllSuppliers (services/supplierSearch) live search, failures isolated
 *   pickBestMatch      (connectors/match.ts)    rank the results for one product
 *   scoreConfidence    (services/matchConfidence) is the winner safe to order?
 *   prepareLine        (allocation/offers.ts)   comparable per-supplier offers
 *   allocate           (allocation/engine.ts)   which supplier gets which line
 *   buildSupplierOrderFile (export/csv.ts)      the finished CSV
 *
 * Allocation runs ONCE over the whole basket rather than per line, which is what
 * makes the per-supplier baskets, the min-order repair pass and the saving-vs-
 * baseline figures meaningful. Each awarded line lands in exactly one supplier's
 * CSV, so both files can be submitted without double-buying.
 *
 * Line identity: the EPOS export carries no barcode at all — only an internal
 * article code — and two suppliers may report different EANs (or none) for the
 * same product. So the allocation line key is the EPOS `articleCode`, treated by
 * the engine as an opaque string, and each supplier's own EAN/SKU/URL rides along
 * on its match row. Keying on EAN would split one article into two lines that
 * never compare with each other.
 *
 * Out of scope by design: no upload to supplier sites, no add-to-cart, no browser
 * automation. This stops at CSV text.
 */

import { importEposListing, type EposImportResult, type ShopArticle } from '../ingest/eposListing.js';
import { cleanSearchQuery } from '../connectors/types.js';
import { pickBestMatch, type MatchTarget } from '../connectors/match.js';
import { prepareLine } from '../allocation/offers.js';
import { allocate, type AllocationResult, type LineAllocation } from '../allocation/engine.js';
import {
  buildSupplierOrderFile,
  DEFAULT_CSV_TEMPLATES,
  type CsvTemplate,
  type SupplierOrderFile,
  type SupplierOrderRow,
} from '../export/csv.js';
import {
  applyConfidenceBooster,
  bucketFor,
  cardGtin,
  DEFAULT_MIN_CONFIDENCE,
  scoreConfidence,
  type ConfidenceBreakdown,
  type ConfidenceResult,
} from './matchConfidence.js';
import {
  confirmAcrossSuppliers,
  type CrossMatchOptions,
} from './eanCrossMatch.service.js';
import {
  mapWithConcurrency,
  searchAllSuppliers,
  sleep,
  SUPPLIER_IDS,
  SUPPLIERS,
  type SupplierSearchError,
  type SupplierSearchHit,
} from './supplierSearch.js';
import type {
  AllocationConfig,
  CanonicalProduct,
  OrderRequestLine,
  PriceQuote,
  ProductMatch,
  Uom,
} from '../types.js';

/** Products searched in parallel. Kept low — these are logged-in trade accounts. */
const DEFAULT_CONCURRENCY = 3;
/** Detail-page fetches per supplier search (O'Reilly needs one per card). */
const DEFAULT_MAX_DETAILS = 5;
/** Pause between product searches per worker, to stay human-paced. */
const DEFAULT_PAUSE_MS = 250;

const DEFAULT_PREFERENCE_BAND = 0.05;
const DEFAULT_OUTLIER_DEVIATION = 0.45;

export interface PrepareOrderOptions {
  /** Order quantity when the sheet's Quantity cell is blank/zero. */
  defaultCases?: number;
  /** Acceptance threshold. Default 0.90. */
  minConfidence?: number;
  /** Planned order date (ISO) — promos ending before it don't count. */
  orderDate?: string;
  preferenceBand?: number;
  outlierDeviation?: number;
  /** Override the CSV column names / filename per supplier. */
  csvTemplates?: Record<string, CsvTemplate>;
  concurrency?: number;
  maxDetailsPerSearch?: number;
  pauseMs?: number;
  /** Safety cap on how many articles to process from a large listing. */
  maxArticles?: number;
  /**
   * Injected in tests so cross-supplier barcode confirmation runs without a
   * database. Production leaves it unset and the local catalogues are used.
   */
  eanLookup?: CrossMatchOptions['lookup'];
}

/** The EPOS line a match refers back to. */
export interface EposLineRef {
  articleCode: string;
  description: string;
  packRaw: string;
  unitsPerCase?: number;
  unitSize?: number;
  cases: number;
  mainCost?: number;
  department?: string;
  subDepartment?: string;
}

/** One supplier's product as matched to an EPOS line. */
export interface SupplierMatchRow {
  supplierId: string;
  supplierName: string;
  /** The supplier's own code — this is what goes in the CSV. */
  supplierSku: string;
  productName: string;
  brand?: string;
  /** Canonical GTIN-14, when the supplier stated a usable EAN. */
  ean?: string;
  productUrl?: string;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: Uom;
  exVatCasePrice?: number;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  reason: string;
  /** True when the allocation engine awarded this line to this supplier. */
  awarded: boolean;
}

export interface MatchedOrderRow {
  epos: EposLineRef;
  /** Every supplier that matched confidently (all of them were candidates). */
  suppliers: SupplierMatchRow[];
  awardedTo?: string;
  awardedSku?: string;
  allocation?: LineAllocation;
}

export interface ReviewOrderRow {
  epos: EposLineRef;
  reason: string;
  /** Best candidate per supplier, strongest first — may be empty. */
  candidates: SupplierMatchRow[];
}

export interface AggregatedSupplierError extends SupplierSearchError {
  /** How many product searches hit this same failure. */
  occurrences: number;
}

export interface PreparedOrderResult {
  storeName?: string;
  /** One entry per supplier, always present even when it has no awarded lines. */
  files: SupplierOrderFile[];
  matched: MatchedOrderRow[];
  needsReview: ReviewOrderRow[];
  unmatched: ReviewOrderRow[];
  /** Rows the EPOS importer itself could not read. */
  skipped: EposImportResult['skipped'];
  supplierErrors: AggregatedSupplierError[];
  summary: {
    articlesInFile: number;
    articlesProcessed: number;
    matched: number;
    needsReview: number;
    unmatched: number;
    skipped: number;
    allocation: Omit<AllocationResult, 'lines'>;
  };
  config: {
    minConfidence: number;
    preferenceBand: number;
    orderDate: string;
    outlierDeviation: number;
  };
}

/** A supplier's best candidate for one EPOS article, with its confidence. */
interface SupplierCandidate {
  supplierId: string;
  hit: SupplierSearchHit;
  gtin?: string;
  confidence: ConfidenceResult;
}

interface ArticleOutcome {
  article: ShopArticle;
  /** Best candidate per supplier, strongest confidence first. */
  candidates: SupplierCandidate[];
  errors: SupplierSearchError[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function eposRef(article: ShopArticle): EposLineRef {
  return {
    articleCode: article.articleCode,
    description: article.description,
    packRaw: article.packRaw,
    cases: article.cases,
    ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    ...(article.mainCost !== undefined ? { mainCost: article.mainCost } : {}),
    ...(article.department ? { department: article.department } : {}),
    ...(article.subDepartment ? { subDepartment: article.subDepartment } : {}),
  };
}

function supplierRow(candidate: SupplierCandidate, awarded: boolean): SupplierMatchRow {
  const { hit, confidence } = candidate;
  const pack = hit.match.caseConfig;
  return {
    supplierId: candidate.supplierId,
    supplierName: SUPPLIERS.get(candidate.supplierId)?.name ?? candidate.supplierId,
    supplierSku: hit.match.supplierSku,
    productName: hit.card.name,
    confidence: confidence.confidence,
    breakdown: confidence.breakdown,
    reason: confidence.reason,
    awarded,
    ...(hit.card.brand ? { brand: hit.card.brand } : {}),
    ...(candidate.gtin ? { ean: candidate.gtin } : {}),
    ...(hit.match.productUrl ? { productUrl: hit.match.productUrl } : {}),
    ...(pack.unitsPerCase ? { unitsPerCase: pack.unitsPerCase } : {}),
    ...(pack.unitSize ? { unitSize: pack.unitSize } : {}),
    ...(pack.uom ? { uom: pack.uom } : {}),
    ...(confidence.breakdown.supplierExVatCasePrice !== undefined
      ? { exVatCasePrice: confidence.breakdown.supplierExVatCasePrice }
      : {}),
  };
}

/**
 * A candidate is only orderable if it carries a product code and a readable
 * price. Confidence says "this is the right product"; these two say "we have
 * enough to place the line". Both are required before a SKU reaches a CSV.
 */
function isOrderable(candidate: SupplierCandidate): boolean {
  const price = candidate.confidence.breakdown.supplierExVatCasePrice;
  return (
    Boolean(candidate.hit.match.supplierSku) &&
    price !== undefined &&
    Number.isFinite(price) &&
    price > 0
  );
}

/** Search every supplier for one EPOS article and score the best result from each. */
async function searchAndScore(
  article: ShopArticle,
  opts: { maxDetails: number; eanLookup?: CrossMatchOptions['lookup'] },
): Promise<ArticleOutcome> {
  const query = cleanSearchQuery(article.description);
  if (!query) return { article, candidates: [], errors: [] };

  const { hits, errors } = await searchAllSuppliers(query, { maxDetails: opts.maxDetails });

  const target: MatchTarget = {
    description: article.description,
    ...(article.unitsPerCase ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize ? { unitSize: article.unitSize } : {}),
  };

  const candidates: SupplierCandidate[] = [];

  for (const supplierId of SUPPLIER_IDS) {
    const list = hits.get(supplierId);
    if (!list || list.length === 0) continue;

    // Identity-keyed so the winning card maps back to its normalized records.
    const byCard = new Map<unknown, SupplierSearchHit>(list.map((h) => [h.card, h]));
    const decision = pickBestMatch(
      target,
      list.map((h) => h.card),
    );
    if (!decision.best) continue;

    const hit = byCard.get(decision.best.card);
    if (!hit) continue;

    const gtin = cardGtin(hit.card);

    candidates.push({
      supplierId,
      hit,
      confidence: scoreConfidence({
        target,
        decision,
        candidate: decision.best,
        quote: hit.quote,
        ...(article.mainCost !== undefined ? { eposMainCost: article.mainCost } : {}),
      }),
      ...(gtin ? { gtin } : {}),
    });
  }

  // Independent identity evidence: the same GTIN-14 is stocked by more than one
  // supplier. Far stronger than any single name match.
  //
  // Decided by `confirmAcrossSuppliers`, the SAME function the dashboard
  // pipeline uses, so the two matchers cannot disagree about whether an
  // identity is confirmed — which they would if each kept its own rule.
  //
  // It also reaches further than the old check did. That one required every
  // responding supplier to have returned the product by TEXT, so a product
  // O'Reilly stocks but whose name its search did not surface counted as
  // unconfirmed. The shared version consults the other supplier's local
  // catalogue by exact barcode, which finds it. No supplier requests are made.
  const seen = new Map<'musgrave' | 'oreilly', Set<string>>([
    ['musgrave', new Set<string>()],
    ['oreilly', new Set<string>()],
  ]);
  for (const candidate of candidates) {
    const bucket = seen.get(candidate.supplierId as 'musgrave' | 'oreilly');
    if (bucket && candidate.gtin) bucket.add(candidate.gtin);
  }

  const { confirmed } = await confirmAcrossSuppliers(
    seen,
    opts.eanLookup ? { lookup: opts.eanLookup } : {},
  );

  if (confirmed.size > 0) {
    for (const candidate of candidates) {
      if (candidate.gtin && confirmed.has(candidate.gtin)) {
        candidate.confidence = applyConfidenceBooster(candidate.confidence, 'cross-supplier-ean');
      }
    }
  }

  candidates.sort((a, b) => b.confidence.confidence - a.confidence.confidence);

  return { article, candidates, errors };
}

function aggregateErrors(outcomes: ArticleOutcome[]): AggregatedSupplierError[] {
  // A bad login fails on every article; report it once with a count.
  const byKey = new Map<string, AggregatedSupplierError>();
  for (const outcome of outcomes) {
    for (const error of outcome.errors) {
      const key = `${error.supplierId} ${error.message}`;
      const existing = byKey.get(key);
      if (existing) existing.occurrences++;
      else byKey.set(key, { ...error, occurrences: 1 });
    }
  }
  return [...byKey.values()];
}

function templateFor(
  supplierId: string,
  overrides: Record<string, CsvTemplate> | undefined,
): CsvTemplate {
  return (
    overrides?.[supplierId] ??
    DEFAULT_CSV_TEMPLATES[supplierId] ?? {
      filename: `${supplierId}-order.csv`,
      skuColumn: 'sku',
      quantityColumn: 'quantity',
      includeHeader: true,
    }
  );
}

/**
 * Parse an EPOS Article Order Listing, match every line against both suppliers,
 * and return a ready-to-submit CSV per supplier plus a full audit trail.
 */
export async function prepareSupplierOrderFiles(
  file: ArrayBuffer | Uint8Array | Buffer | string,
  opts: PrepareOrderOptions = {},
): Promise<PreparedOrderResult> {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
  const maxDetails = opts.maxDetailsPerSearch ?? DEFAULT_MAX_DETAILS;

  const config: AllocationConfig = {
    preferenceBand: opts.preferenceBand ?? DEFAULT_PREFERENCE_BAND,
    orderDate: opts.orderDate ?? todayIso(),
    outlierDeviation: opts.outlierDeviation ?? DEFAULT_OUTLIER_DEVIATION,
  };

  // 1. Parse — the existing importer is the only parser in this pipeline.
  const parsed = importEposListing(
    file,
    opts.defaultCases !== undefined ? { defaultCases: opts.defaultCases } : {},
  );
  const articles =
    opts.maxArticles !== undefined
      ? parsed.articles.slice(0, opts.maxArticles)
      : parsed.articles;

  // 2. Search + match, a few products at a time.
  const outcomes = await mapWithConcurrency(
    articles,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (article, index) => {
      if (index > 0 && pauseMs > 0) await sleep(pauseMs);
      return searchAndScore(article, {
        maxDetails,
        ...(opts.eanLookup ? { eanLookup: opts.eanLookup } : {}),
      });
    },
  );

  // 3. Bucket each article by its best available evidence.
  const matchedOutcomes: { outcome: ArticleOutcome; accepted: SupplierCandidate[] }[] = [];
  const needsReview: ReviewOrderRow[] = [];
  const unmatched: ReviewOrderRow[] = [];

  for (const outcome of outcomes) {
    const accepted = outcome.candidates.filter(
      (c) => bucketFor(c.confidence.confidence, minConfidence) === 'matched' && isOrderable(c),
    );

    if (accepted.length > 0) {
      matchedOutcomes.push({ outcome, accepted });
      continue;
    }

    const best = outcome.candidates[0];
    const bucket = best ? bucketFor(best.confidence.confidence, minConfidence) : 'unmatched';

    let reason: string;
    if (!best) {
      reason =
        outcome.errors.length > 0
          ? 'No supplier could be searched for this line.'
          : 'No supplier returned any result for this description.';
    } else if (bucket === 'matched') {
      // Confident about the product, but missing what it takes to order it.
      reason = 'Matched, but the supplier card had no usable product code or price.';
    } else {
      reason = best.confidence.reason;
    }

    const row: ReviewOrderRow = {
      epos: eposRef(outcome.article),
      candidates: outcome.candidates.map((c) => supplierRow(c, false)),
      reason,
    };

    // 'matched' here means confident-but-not-orderable, which is a human's call
    // rather than a dead end — both it and 'needs-review' go to the review list.
    if (bucket === 'unmatched') unmatched.push(row);
    else needsReview.push(row);
  }

  // 4. Build allocator input keyed on the EPOS article code (see header note).
  const matches: ProductMatch[] = [];
  const quotes: PriceQuote[] = [];
  const products = new Map<string, CanonicalProduct>();
  const lines: OrderRequestLine[] = [];

  for (const { outcome, accepted } of matchedOutcomes) {
    const key = outcome.article.articleCode;
    const primary = accepted[0]!; // sorted by confidence

    // Neither supplier service detects PMP / own-brand, so keep those flags
    // consistent across the product and its matches — otherwise `prepareLine`'s
    // hard constraint would silently drop offers on a mismatch it can't verify.
    const product: CanonicalProduct = {
      unitGtin: key,
      name: primary.hit.product.name,
      brand: primary.hit.product.brand,
      isPmp: false,
      isOwnBrand: false,
    };
    products.set(key, product);

    for (const candidate of accepted) {
      matches.push({
        ...candidate.hit.match,
        unitGtin: key,
        isPmp: false,
        isOwnBrand: false,
      });
      quotes.push(candidate.hit.quote);
    }

    lines.push({ unitGtin: key, cases: outcome.article.cases });
  }

  // 5. One allocation over the whole basket.
  const prepared = lines.map((line) =>
    prepareLine(line, { matches, quotes, suppliers: SUPPLIERS, products, config }),
  );
  const allocation = allocate(prepared, [...SUPPLIERS.values()], config);
  const allocationByKey = new Map(allocation.lines.map((l) => [l.unitGtin, l]));

  // 6. Per-supplier CSVs from the awarded lines, in EPOS file order.
  const rowsBySupplier = new Map<string, SupplierOrderRow[]>(
    SUPPLIER_IDS.map((id) => [id, [] as SupplierOrderRow[]]),
  );
  for (const line of allocation.lines) {
    if (line.status !== 'allocated' || !line.supplierId || !line.supplierSku) continue;
    const bucket = rowsBySupplier.get(line.supplierId);
    if (!bucket) continue;
    bucket.push({ supplierSku: line.supplierSku, cases: line.cases });
  }

  const files = SUPPLIER_IDS.map((id) =>
    buildSupplierOrderFile(
      id,
      rowsBySupplier.get(id) ?? [],
      templateFor(id, opts.csvTemplates),
    ),
  );

  // 7. Audit trail.
  const matched: MatchedOrderRow[] = matchedOutcomes.map(({ outcome, accepted }) => {
    const line = allocationByKey.get(outcome.article.articleCode);
    return {
      epos: eposRef(outcome.article),
      suppliers: accepted.map((c) => supplierRow(c, line?.supplierId === c.supplierId)),
      ...(line?.supplierId ? { awardedTo: line.supplierId } : {}),
      ...(line?.supplierSku ? { awardedSku: line.supplierSku } : {}),
      ...(line ? { allocation: line } : {}),
    };
  });

  const { lines: _allocationLines, ...allocationSummary } = allocation;

  return {
    files,
    matched,
    needsReview,
    unmatched,
    skipped: parsed.skipped,
    supplierErrors: aggregateErrors(outcomes),
    summary: {
      articlesInFile: parsed.articles.length,
      articlesProcessed: articles.length,
      matched: matched.length,
      needsReview: needsReview.length,
      unmatched: unmatched.length,
      skipped: parsed.skipped.length,
      allocation: allocationSummary,
    },
    config: { minConfidence, ...config },
    ...(parsed.storeName ? { storeName: parsed.storeName } : {}),
  };
}
