/**
 * One Excel row → one dashboard row.
 *
 *   article → supplier search → SBERT → rule engine → reconciliation → row
 *
 * This is orchestration only. Every stage is the tested module that already
 * exists; nothing here re-implements parsing, searching, scoring, selection or
 * reconciliation:
 *
 *   searchMusgrave / searchOreilly   live supplier search
 *   candidateFromCard                card → neutral candidate (honest unknown packs)
 *   rankCandidates                   the external SBERT service
 *   judgeCandidates                  deterministic rules
 *   selectFinal                      at most one product per supplier
 *   reconcileSelection               the safety gate
 *
 * The invariant this module exists to enforce
 * -------------------------------------------
 * ONE Excel row produces EXACTLY ONE dashboard row — either Ready To Order or
 * Needs Attention, never both and never neither. Supplier candidates are not
 * dashboard rows; the dashboard shows the retailer's products, not search
 * results. Rejected candidates survive only inside the popup payload, and only
 * when they are genuine commercial alternatives.
 */

import {
  canonicalQuery,
  normalizeProduct,
  type ExtractedMetadata,
} from '../normalization/productNormalization.js';
import { searchMusgrave } from './musgrave.service.js';
import { searchOreilly } from './oreilly.service.js';
import { toExVat } from '../pricing/normalize.js';
import { rankCandidates, type AiCandidate } from './aiMatch.client.js';
import {
  candidateFromCard,
  judgeCandidates,
  selectFinal,
  type CandidateJudgement,
  type RuleCandidate,
  type RuleTarget,
  type SelectedCandidate,
} from './ruleEngine.js';
import {
  reconcileProduct,
  reconcileSelection,
  type ReconciliationCode,
  type ReconciliationRequest,
  type ReconciliationResult,
} from './productReconciliation.service.js';
import { SUPPLIERS } from './supplierSearch.js';
import {
  queryUnderstandingEnabled,
  understandQuery,
  type UnderstoodAttributes,
} from './queryUnderstanding.client.js';
import {
  DIFFERENT_EXPLANATION,
  resolveCommercialEquivalence,
  type EquivalenceResolution,
} from './commercialEquivalence.js';
import {
  loadAllProductOverrides,
  overrideKey,
  type ProductOverride,
} from '../repositories/adminOverride.repository.js';
import { getMatchingConfig } from '../normalization/matchingConfig.js';
import { buildSearchQueryPlan, RECALL_TARGET } from '../parsing/searchQuery.js';
import { splitCompounds } from '../parsing/compoundSplitter.js';
import { vocabularyFor } from '../parsing/productParser.js';
import type { ShopArticle } from '../ingest/eposListing.js';

/** Detail-page fetches per O'Reilly search. */
const DEFAULT_MAX_DETAILS = 5;

// ---- Row shapes ------------------------------------------------------------

/** A supplier offer for the popup and for the best-supplier decision. */
export interface DashboardOffer {
  supplier: string;
  supplierName: string;
  product: string;
  sku?: string;
  ean?: string;
  exVatCasePrice?: number;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: string;
  /** Absolute thumbnail URL, when the supplier publishes one. */
  imageUrl?: string;
  /** This is the product an admin confirmed for this description. */
  adminConfirmed?: boolean;
}

/**
 * A commercial alternative shown in the popup.
 *
 * Strictly NOT "every rejected candidate": only products of the same commercial
 * family at a comparable pack, which differ from the request in a way the
 * retailer might actually want to choose.
 */
export interface CommercialAlternative extends DashboardOffer {
  /** Short human phrase, e.g. "Variant only". */
  difference: string;
  /** Machine-readable, for future "select this variant". */
  differenceCodes: ReconciliationCode[];
}

/** Everything the product-detail popup renders. */
export interface ProductDetail {
  requestedProduct: string;
  requestedPack?: string;
  selected?: DashboardOffer;
  /** Same-family, comparable-pack products only. */
  alternatives: CommercialAlternative[];
  /** Every supplier that cleared reconciliation, for price context. */
  offers: DashboardOffer[];
}

export interface ReadyToOrderRow {
  kind: 'ready';
  /** Excel row number — the dashboard's stable key. One row, one product. */
  row: number;
  articleCode: string;
  product: string;
  bestSupplier: string;
  bestSupplierName: string;
  price: number;
  cases: number;
  /** Per-case saving against the baseline, when one exists. */
  /**
   * Saving per case against the retailer's current cost. Present ONLY when the
   * selected supplier is genuinely cheaper — never negative.
   *
   *   savings = eposMainCost − selectedSupplierExVatCasePrice   (when > 0)
   */
  savings?: number;
  savingsPct?: number;
  /** The retailer's current cost per case, from the Excel "Cost" column. */
  baselineCost?: number;
  /**
   * Signed difference, always present when a baseline exists. Negative means the
   * supplier is dearer than the retailer currently pays — kept so the dashboard
   * can say so instead of hiding it.
   */
  costDelta?: number;
  /**
   * 'saving'      — cheaper than the retailer's current cost
   * 'no-saving'   — same or dearer
   * 'no-baseline' — the file stated no cost, so no saving can be claimed
   */
  savingsStatus: 'saving' | 'no-saving' | 'no-baseline';
  /**
   * Whether this line is already in the supplier's cart. The pipeline always
   * produces 'No' — nothing adds to a cart yet — but the type admits 'Yes' so
   * the persisted `added_to_cart` column can round-trip once it does.
   */
  addedToCart: 'Yes' | 'No';
  /**
   * Non-blocking caveats on an otherwise clean line — a near unit size, an
   * unverifiable pack, a differing barcode. The line IS orderable; the retailer
   * should simply see what was not an exact match rather than having the line
   * disappear into Needs Attention. Empty means a clean pass.
   */
  warnings: {
    code: string;
    message: string;
    /**
     * This would have blocked the line, but an admin confirmed the product
     * anyway. It is the difference between "we noticed something odd" and "the
     * product a person chose is not what the file asked for" — the dashboard
     * says the second thing, which is the one worth reading.
     */
    overriddenByAdmin?: boolean;
  }[];
  /**
   * Set when this line's product was chosen by an admin rather than found by the
   * matcher. Present on the row itself, not just inside the offer, because the
   * dashboard has to be able to label the line before opening it.
   */
  adminConfirmed?: {
    supplier: string;
    supplierSku: string;
    /** Who confirmed it, when the override recorded an author. */
    by?: string;
    /**
     * True when the confirmed product differs from the order line in some way —
     * pack, size, variant, container. The reasons are in `warnings`.
     */
    differsFromRequest: boolean;
  };
  /**
   * Why this line did not need a human, when it looked like it might.
   *
   * Present only when the commercial-equivalence stage settled something —
   * several listings of one product, decided on price. Absent on lines that
   * were never in doubt, so it reads as an explanation rather than noise.
   */
  explanation?: string;
  detail: ProductDetail;
}

export interface NeedsAttentionRow {
  kind: 'attention';
  row: number;
  articleCode: string;
  product: string;
  status: string;
  reason: string;
  suggestion: string;
  codes: ReconciliationCode[];
  /** Set when equivalence was tried and the candidates are genuinely different. */
  explanation?: string;

  /**
   * WHAT THE RETAILER ACTUALLY ASKED FOR.
   *
   * A Ready To Order row carries this in `detail`, and an attention row used to
   * carry nothing but a verdict — status, reason, suggestion. That is the wrong
   * way round: the line a human has to settle BY HAND is the one where knowing
   * the requested pack and quantity matters most, and without them an admin has
   * to reopen the source file to answer "how many of what".
   *
   * Absent when the file stated no pack, which is itself worth showing — "not
   * stated" is a different fact from "not known", and a blank field conflates
   * them.
   */
  requestedPack?: string;
  /** Cases ordered. Defaults to 1 upstream, so this is always a real number. */
  cases: number;
}

export type DashboardRow = ReadyToOrderRow | NeedsAttentionRow;

/** Diagnostics kept off the dashboard but worth persisting. */
export interface RowDiagnostics {
  /** The description exactly as the retailer's file wrote it. */
  originalQuery: string;
  /** The precise identity — what the rules and reconciliation compare on. */
  canonicalIdentity: string;
  /** The query that actually produced the candidates. */
  searchQuery: string;
  /**
   * Every rung of the retrieval ladder that was tried, with how many candidates
   * it returned. Zero at the top and results further down is a SEARCH RECALL
   * problem, not a matching problem — the counts are what tell them apart.
   */
  retrieval: { level: number; query: string; rationale: string; candidates: number }[];
  /** Everything normalization set aside — prices, flags, container, expansions. */
  normalizationMetadata?: ExtractedMetadata;
  /**
   * Which stage produced the search queries. 'rules' when the model was off,
   * unreachable, or answered with nothing usable — so a run can always be told
   * apart from one that only LOOKS like it used the model.
   */
  querySource?: QueryStrategy;
  /** Set when the model was asked and fell back. */
  queryModelError?: string;
  queryModelMs?: number;
  queryModelConfidence?: number;
  candidateCount: number;
  supplierErrors: { supplier: string; message: string }[];
  aiError?: string;
  aiMs?: number;
  totalMs: number;
}

export interface ProcessedArticle {
  row: DashboardRow;
  diagnostics: RowDiagnostics;
  /** Full audit trail — persisted, never rendered as dashboard rows. */
  judgements: CandidateJudgement[];
  reconciliations: ReconciliationResult[];
  /** What the commercial-equivalence stage did, per supplier. Empty when idle. */
  equivalence: EquivalenceResolution[];
}

/**
 * Where the supplier search queries come from.
 *
 *   'rules'  the deterministic ladder in parsing/searchQuery.ts — drop trailing
 *            tokens from the canonical identity until something comes back
 *   'model'  the fine-tuned Query Understanding model, which reads the line's
 *            attributes and builds the ladder from brand / variant / product
 *
 * This is the ONLY stage the model participates in. SBERT ranking, the rule
 * engine and reconciliation receive exactly what they received before, from
 * exactly the same code.
 */
export type QueryStrategy = 'rules' | 'model';

export interface ProcessArticleOptions {
  maxDetails?: number;
  /** Injected in tests so the pipeline can run without live suppliers. */
  searchers?: {
    musgrave: (query: string) => Promise<RuleCandidate[]>;
    oreilly: (query: string) => Promise<RuleCandidate[]>;
  };
  rank?: typeof rankCandidates;
  /** Defaults to the QUERY_UNDERSTANDING environment switch. */
  queryStrategy?: QueryStrategy;
  /** Injected by the A/B harness so both arms share one model call. */
  understand?: typeof understandQuery;
  /**
   * Resolve "too close to call" groups that are one commercial product.
   * Defaults ON; the harness turns it off to measure the stage against itself.
   */
  commercialEquivalence?: boolean;
  /**
   * Honour admin confirmations. Defaults ON in production, OFF when a caller
   * supplies its own searchers — tests inject fake suppliers and must not have
   * a live database consulted underneath them.
   */
  adminOverrides?: boolean;
}

/**
 * The admin confirmation for one order line, if a human has made one.
 *
 * Read from a cached snapshot of the whole table rather than per line: the
 * pipeline asks once per row, and 213 round trips to answer a question whose
 * answer barely changes is not a trade worth making.
 *
 * A lookup failure is downgraded to "no override". Losing a human's correction
 * for one run is a bad day; failing the whole file because a table could not be
 * read is a worse one, and the pipeline already has a correct answer without it.
 */
async function findOverride(
  description: string,
  opts: ProcessArticleOptions,
): Promise<ProductOverride | undefined> {
  const enabled = opts.adminOverrides ?? opts.searchers === undefined;
  if (!enabled) return undefined;

  try {
    const all = await loadAllProductOverrides();
    return all.get(overrideKey(description))?.[0];
  } catch {
    return undefined;
  }
}

// ---- Helpers ---------------------------------------------------------------

function supplierName(id: string): string {
  return SUPPLIERS.get(id)?.name ?? id;
}

function packLabel(unitsPerCase?: number, unitSize?: number, uom?: string): string | undefined {
  if (unitsPerCase === undefined || unitSize === undefined) return undefined;
  return `${unitsPerCase} × ${unitSize}${uom ?? ''}`;
}

function toOffer(candidate: SelectedCandidate | RuleCandidate, name?: string): DashboardOffer {
  return {
    supplier: candidate.supplier,
    supplierName: supplierName(candidate.supplier),
    product: name ?? candidate.name,
    ...(candidate.sku ? { sku: candidate.sku } : {}),
    ...(candidate.ean ? { ean: candidate.ean } : {}),
    ...(candidate.exVatCasePrice !== undefined
      ? { exVatCasePrice: candidate.exVatCasePrice }
      : {}),
    ...(candidate.unitsPerCase !== undefined ? { unitsPerCase: candidate.unitsPerCase } : {}),
    ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
    ...(candidate.uom ? { uom: candidate.uom } : {}),
    ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
    ...(candidate.adminConfirmed ? { adminConfirmed: true } : {}),
  };
}

/**
 * Choose the supplier to buy this line from.
 *
 * THE BUYING OBJECTIVE: among candidates that already cleared the rule engine
 * AND reconciliation, take the LOWEST ex-VAT case price. Supplier preference is
 * a tie-breaker only, applied when prices are within `priceTieToleranceEur`.
 *
 * This replaced a preference-first rule that used each supplier's own
 * percentage threshold from `SUPPLIERS` (Musgrave 10%, O'Reilly 13%). On real
 * data that rule kept a line at Musgrave for €18.99 when O'Reilly listed the
 * verified-equivalent product at €16.75, because:
 *
 *   (18.99 − 16.75) / 18.99 = 11.8%  <  O'Reilly's 13% threshold
 *
 * — a €2.24 saving per case discarded to preference. Those thresholds model the
 * switching cost of moving a WHOLE BASKET between suppliers and still apply in
 * the allocation engine; they were never meant to veto a cheaper equivalent on
 * a single line.
 *
 * Callers must pass only verified candidates. This function does not re-check
 * identity — by design, so that "which is cheapest" cannot silently start
 * meaning "which is cheapest among things we never confirmed".
 */
export function chooseBestSupplier(
  offers: readonly DashboardOffer[],
): DashboardOffer | undefined {
  const priced = offers.filter(
    (offer) => offer.exVatCasePrice !== undefined && offer.exVatCasePrice > 0,
  );
  if (priced.length === 0) return undefined;

  // An admin's confirmation is a decision about WHICH PRODUCT, and the supplier
  // came with it. Letting the cheapest offer win here would quietly buy a
  // different supplier's listing than the one a person approved — a saving the
  // retailer did not ask for, on a line they explicitly settled by hand.
  //
  // Narrowing the pool rather than returning early keeps ONE ordering rule in
  // this function: if an admin confirmed the same description at both suppliers
  // — a legitimate standing decision — price still decides between those two,
  // exactly as it would among any other verified equals.
  const confirmed = priced.filter((offer) => offer.adminConfirmed);
  const pool = confirmed.length > 0 ? confirmed : priced;

  const { priceTieToleranceEur, preferenceOrder } = getMatchingConfig().supplierSelection;

  const preference = (offer: DashboardOffer) => {
    const index = preferenceOrder.indexOf(offer.supplier);
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  };

  return [...pool].sort((a, b) => {
    const difference = a.exVatCasePrice! - b.exVatCasePrice!;
    // Effectively equal → preference decides. Otherwise price decides, always.
    if (Math.abs(difference) > priceTieToleranceEur) return difference;
    const byPreference = preference(a) - preference(b);
    if (byPreference !== 0) return byPreference;
    return a.supplier.localeCompare(b.supplier);
  })[0]!;
}

/**
 * The commercial alternatives worth showing in the popup.
 *
 * Reconciliation is re-run against every judged candidate, and a candidate is an
 * alternative only when its ONLY critical difference is the variant. That is
 * exactly "same commercial family, comparable pack, differs by variant" — a
 * different pack, unit, container or product fails on its own code and is
 * excluded. So this can never degenerate into "every rejected candidate".
 */
export function commercialAlternatives(
  request: ReconciliationRequest,
  candidates: readonly RuleCandidate[],
  judgements: readonly CandidateJudgement[],
  selected: readonly SelectedCandidate[],
): CommercialAlternative[] {
  const chosenKeys = new Set(selected.map((s) => `${s.supplier}:${s.sku ?? s.name}`));
  const knownBrands = [...new Set(candidates.map((c) => c.brand).filter(Boolean))];
  const seen = new Set<string>();
  const alternatives: CommercialAlternative[] = [];

  for (const judgement of judgements) {
    const candidate = candidates[judgement.candidateIndex];
    if (!candidate) continue;

    const key = `${candidate.supplier}:${candidate.sku ?? candidate.name}`;
    if (chosenKeys.has(key) || seen.has(key)) continue;

    // A usable alternative must actually be orderable.
    if (!candidate.sku || !candidate.exVatCasePrice) continue;

    const result = reconcileProduct(
      request,
      {
        supplier: candidate.supplier,
        candidateIndex: judgement.candidateIndex,
        name: candidate.name,
        ...(candidate.brand ? { brand: candidate.brand } : {}),
        ...(candidate.sku ? { sku: candidate.sku } : {}),
        ...(candidate.ean ? { ean: candidate.ean } : {}),
        ...(candidate.unitsPerCase !== undefined
          ? { unitsPerCase: candidate.unitsPerCase }
          : {}),
        ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
        ...(candidate.uom ? { uom: candidate.uom } : {}),
        ...(candidate.exVatCasePrice !== undefined
          ? { exVatCasePrice: candidate.exVatCasePrice }
          : {}),
        finalConfidence: judgement.finalConfidence,
        sbertSimilarity: judgement.sbertSimilarity,
        reason: judgement.reason,
      },
      knownBrands,
    );

    const codes = [...new Set(result.differences.map((d) => d.code))].filter(
      (code) => code !== 'BRAND_MISMATCH' && code !== 'EAN_DIFFERENCE',
    );

    // An alternative is something the retailer might DELIBERATELY choose: a
    // different variant, or a different size of the same product. Anything that
    // makes it a different product — wrong container, wrong form, wrong alcohol
    // strength, or no shared identity at all — is not an alternative, it is a
    // wrong answer, and offering it just moves the rejection one click later.
    const NOT_AN_ALTERNATIVE: ReconciliationCode[] = [
      'PRODUCT_IDENTITY_MISMATCH',
      'CONTAINER_MISMATCH',
      'UNIT_MISMATCH',
      'ALCOHOL_MISMATCH',
      'MISSING_SKU',
      'MISSING_PRICE',
    ];
    if (codes.some((code) => NOT_AN_ALTERNATIVE.includes(code))) continue;

    // The retailer needs to know EVERYTHING that differs in order to choose.
    // Reporting only the first difference mislabelled a 6 × 64g bottle as
    // "Variant only" when its pack differed too.
    const differs: string[] = [];
    if (codes.includes('VARIANT_MISMATCH')) differs.push('variant');
    if (codes.includes('PACK_MISMATCH') || codes.includes('MULTIPACK_MISMATCH')) {
      differs.push(`pack ${candidate.unitsPerCase} × ${candidate.unitSize}${candidate.uom ?? ''}`);
    } else if (codes.includes('UNIT_SIZE_MISMATCH')) {
      differs.push(`size ${candidate.unitSize}${candidate.uom ?? ''}`);
    }

    const difference =
      differs.length === 0
        ? 'Same product, different listing'
        : `Differs by ${differs.join(' and ')}`;

    seen.add(key);
    alternatives.push({ ...toOffer(candidate), difference, differenceCodes: codes });
  }

  return alternatives;
}

/** A plain-language next step for a line that needs attention. */
function suggestionFor(codes: readonly ReconciliationCode[], status: string): string {
  if (status === 'No supplier found') {
    return 'Check the description spelling, or search the supplier portal manually.';
  }
  if (codes.includes('VARIANT_MISMATCH')) {
    return 'Suppliers only stock a different variant. Open the product to pick one, or reword the line to name the variant you want.';
  }
  if (codes.includes('PACK_MISMATCH') || codes.includes('UNIT_SIZE_MISMATCH')) {
    return 'Suppliers stock this product in a different pack. Confirm the pack size on the order line.';
  }
  if (codes.includes('PACK_NOT_VERIFIABLE')) {
    return 'Neither side states a full pack size. Add units-per-case and unit size to the order line.';
  }
  if (codes.includes('MISSING_PRICE') || codes.includes('MISSING_SKU')) {
    return 'The supplier listing has no usable code or price — check availability on the portal.';
  }
  if (codes.includes('MULTIPACK_MISMATCH')) {
    return 'Only a multipack version was found. Confirm whether the multipack is acceptable.';
  }
  return 'Review this line manually before ordering.';
}

// ---- Supplier search -------------------------------------------------------

async function searchSupplier(
  supplier: 'musgrave' | 'oreilly',
  query: string,
  opts: ProcessArticleOptions,
): Promise<{ candidates: RuleCandidate[]; error?: string }> {
  try {
    if (opts.searchers) {
      return { candidates: await opts.searchers[supplier](query) };
    }

    const maxDetails = opts.maxDetails ?? DEFAULT_MAX_DETAILS;
    const hits =
      supplier === 'musgrave'
        ? await searchMusgrave(query)
        : await searchOreilly(query, { maxDetails });

    return {
      candidates: hits.map((hit) => {
        const exVat = toExVat(
          hit.quote.rawCasePrice,
          hit.quote.vatRate,
          hit.quote.priceIsVatInclusive,
        );
        return candidateFromCard(supplier, hit.card, Number.isFinite(exVat) ? exVat : undefined);
      }),
    };
  } catch (error) {
    return {
      candidates: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---- Query generation ------------------------------------------------------

/** The retrieval ladder plus where it came from, for the diagnostics. */
interface RetrievalPlan {
  levels: { level: number; query: string; rationale: string }[];
  source: QueryStrategy;
  /** Present when the model was asked and could not answer. */
  modelError?: string;
  modelMs?: number;
  modelConfidence?: number;
  modelAttributes?: UnderstoodAttributes;
}

/**
 * Build the supplier search ladder for one order line.
 *
 * THE ONLY STAGE THIS CHANGE TOUCHES.
 *
 * The rule ladder shortens the canonical identity token by token until
 * something comes back, which works but is blind: "WRIGLEYS EXTRA PEPPERMINT
 * GUM 46P" is shortened from the right, so the useless "46P" is the first thing
 * dropped only by luck of position. The model reads the line instead — it knows
 * 46P is a piece count, that BTL is a container and that AIRWAVES is the brand
 * — and builds the ladder from the attributes.
 *
 * The model gets the RAW description. It was trained on retail language, so
 * normalizing first would strip the very tokens it was taught to recognise.
 *
 * Falls back to the rule ladder whenever the model is off, unreachable, or
 * returns nothing usable. A model outage costs recall, never an order.
 */
async function buildRetrievalPlan(
  article: ShopArticle,
  canonicalIdentity: string,
  normalized: ReturnType<typeof normalizeProduct>,
  opts: ProcessArticleOptions,
): Promise<RetrievalPlan> {
  const rules = (): RetrievalPlan => ({
    levels: buildSearchQueryPlan({
      canonicalIdentity,
      discriminators: [normalized.extractedMetadata.abv],
    }).levels,
    source: 'rules',
  });

  const strategy =
    opts.queryStrategy ?? (queryUnderstandingEnabled() ? 'model' : 'rules');
  if (strategy !== 'model') return rules();

  const understand = opts.understand ?? understandQuery;
  // Five rungs, not the model's default three. The retrieval loop stops as soon
  // as it has RECALL_TARGET candidates, so extra rungs cost nothing on a line
  // that matches early and are the whole difference on one that does not — the
  // rule ladder it replaces broadens all the way down to a single token.
  const understood = await understand(article.description, { maxQueries: 5 });

  if (understood.error || understood.searchQueries.length === 0) {
    const fallback = rules();
    return {
      ...fallback,
      ...(understood.error ? { modelError: understood.error } : {}),
      modelMs: understood.durationMs,
    };
  }

  return {
    levels: understood.searchQueries.map((query, index) => ({
      level: index,
      query,
      rationale:
        index === 0
          ? 'model: brand + variant + product'
          : `model: broadened, rung ${index + 1}`,
    })),
    source: 'model',
    modelMs: understood.durationMs,
    modelConfidence: understood.confidence,
    modelAttributes: understood.attributes,
  };
}

// ---- The pipeline ----------------------------------------------------------

/**
 * Run one Excel article through the whole matching pipeline.
 *
 * Never throws: a supplier outage, an AI outage or an unmatchable description
 * all produce a Needs Attention row rather than losing the line. In a 2000-row
 * job, one bad line must not stop the other 1999.
 */
export async function processArticle(
  article: ShopArticle,
  opts: ProcessArticleOptions = {},
): Promise<ProcessedArticle> {
  const startedAt = Date.now();

  // --- Product normalization ----------------------------------------------
  // Runs BEFORE search and before SBERT. Suppliers and the encoder receive the
  // commercial product name alone: "LUCOZADE ZERO ORIGINAL BTL €2.20" becomes
  // "LUCOZADE ZERO ORIGINAL". Prices, retail flags and the container are set
  // aside in metadata, not discarded.
  const normalized = normalizeProduct(article.description);

  // ONE canonical string, used by supplier search, SBERT, the rule engine and
  // reconciliation alike. Previously the search box received
  // `cleanSearchQuery(normalized)` while everything downstream received
  // `normalized` — so a product could be judged against text it was never
  // searched for. `canonicalQuery` is now the only producer of this string.
  const query = canonicalQuery(article.description);

  const target: RuleTarget = {
    description: query,
    // Extracted by normalization and carried explicitly — the description no
    // longer contains it, so this is the only way containers stay comparable.
    ...(normalized.extractedMetadata.container
      ? { container: normalized.extractedMetadata.container }
      : {}),
    ...(normalized.extractedMetadata.form
      ? { form: normalized.extractedMetadata.form }
      : {}),
    // A count that merely restates the case ("24 PACK" on a 24-per-case line)
    // is the case, not a multipack — the same guard `multipackCount` applies.
    ...(normalized.extractedMetadata.multipackCount !== undefined &&
    normalized.extractedMetadata.multipackCount !== article.unitsPerCase
      ? { multipack: normalized.extractedMetadata.multipackCount }
      : {}),
    ...(normalized.extractedMetadata.abv !== undefined
      ? { abv: normalized.extractedMetadata.abv }
      : {}),
    ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    ...(article.mainCost !== undefined ? { mainCost: article.mainCost } : {}),
  };
  const request: ReconciliationRequest = {
    ...target,
    row: article.sourceRow,
    articleCode: article.articleCode,
  };

  // Declared before `finish` so the early "no searchable description" return can
  // report a source too. Reassigned once the ladder is actually built.
  let plan: RetrievalPlan = { levels: [], source: 'rules' };

  const attention = (status: string, reason: string, codes: ReconciliationCode[] = []) => ({
    kind: 'attention' as const,
    row: article.sourceRow,
    articleCode: article.articleCode,
    product: article.description,
    status,
    reason,
    suggestion: suggestionFor(codes, status),
    codes,
    // Same derivation the Ready To Order path uses, so "24 x 38 g" means the
    // same thing on both tables rather than being formatted twice.
    ...(packLabel(article.unitsPerCase, article.unitSize)
      ? { requestedPack: packLabel(article.unitsPerCase, article.unitSize)! }
      : {}),
    cases: article.cases,
  });

  const finish = (
    row: DashboardRow,
    extras: {
      supplierErrors?: { supplier: string; message: string }[];
      aiError?: string;
      aiMs?: number;
      candidateCount?: number;
      judgements?: CandidateJudgement[];
      reconciliations?: ReconciliationResult[];
      equivalence?: EquivalenceResolution[];
      searchQuery?: string;
      retrieval?: RowDiagnostics['retrieval'];
    } = {},
  ): ProcessedArticle => ({
    row,
    diagnostics: {
      originalQuery: article.description,
      canonicalIdentity: query,
      searchQuery: extras.searchQuery ?? query,
      retrieval: extras.retrieval ?? [],
      normalizationMetadata: normalized.extractedMetadata,
      querySource: plan.source,
      ...(plan.modelError ? { queryModelError: plan.modelError } : {}),
      ...(plan.modelMs !== undefined ? { queryModelMs: plan.modelMs } : {}),
      ...(plan.modelConfidence !== undefined
        ? { queryModelConfidence: plan.modelConfidence }
        : {}),
      candidateCount: extras.candidateCount ?? 0,
      supplierErrors: extras.supplierErrors ?? [],
      ...(extras.aiError ? { aiError: extras.aiError } : {}),
      ...(extras.aiMs !== undefined ? { aiMs: extras.aiMs } : {}),
      totalMs: Date.now() - startedAt,
    },
    judgements: extras.judgements ?? [],
    reconciliations: extras.reconciliations ?? [],
    equivalence: extras.equivalence ?? [],
  });

  if (!query) {
    return finish(
      attention('No supplier found', 'The order line has no searchable description.'),
    );
  }

  // --- Retrieval: broad, then re-rank -------------------------------------
  //
  // Supplier search is keyword-AND, so every extra token can only shrink the
  // result set and one unrecognised token empties it. Queries are issued from
  // most to least specific and UNIONED, stopping once there is enough for the
  // rules to judge. Precision is recovered downstream by SBERT and the rules —
  // a candidate the rules reject costs one comparison, but a candidate
  // retrieval never returned cannot be recovered at all.
  plan = await buildRetrievalPlan(article, query, normalized, opts);

  // A human has already answered this line. Put their SKU at the TOP of the
  // ladder rather than replacing the ladder: suppliers match SKUs in their own
  // search, so this retrieves the confirmed product, and keeping the other
  // rungs means the row still shows alternatives and prices for context.
  const override = await findOverride(article.description, opts);
  if (override) {
    plan = {
      ...plan,
      levels: [
        {
          level: 0,
          query: override.supplierSku,
          rationale: `admin-confirmed ${override.supplier} ${override.supplierSku}`,
        },
        ...plan.levels.map((rung) => ({ ...rung, level: rung.level + 1 })),
      ],
    };
  }

  const retrieval: RowDiagnostics['retrieval'] = [];
  const supplierErrors: { supplier: string; message: string }[] = [];
  const bySku = new Map<string, RuleCandidate>();
  let searchQueryUsed = query;

  for (const rung of plan.levels) {
    const [musgrave, oreilly] = await Promise.all([
      searchSupplier('musgrave', rung.query, opts),
      searchSupplier('oreilly', rung.query, opts),
    ]);

    for (const error of [
      ...(musgrave.error ? [{ supplier: 'musgrave', message: musgrave.error }] : []),
      ...(oreilly.error ? [{ supplier: 'oreilly', message: oreilly.error }] : []),
    ]) {
      if (!supplierErrors.some((existing) => existing.supplier === error.supplier)) {
        supplierErrors.push(error);
      }
    }

    const found = [...musgrave.candidates, ...oreilly.candidates];
    for (const candidate of found) {
      // Deduplicated across rungs — a broader query re-returns the narrow hits.
      bySku.set(`${candidate.supplier}:${candidate.sku ?? candidate.name}`, candidate);
    }

    retrieval.push({ ...rung, candidates: found.length });
    if (found.length > 0) searchQueryUsed = rung.query;
    if (bySku.size >= RECALL_TARGET) break;
  }

  const candidates = [...bySku.values()];

  // Tie the human's decision to the product that actually came back.
  //
  // Matched on supplier AND SKU, never the SKU alone: the suppliers' code
  // namespaces are independent, so an O'Reilly listing that happens to share a
  // number with Musgrave 709040 is not the product the admin approved. Rung 0
  // searched for the SKU, but a supplier's search box is free to return
  // anything it likes for it, so what it returned still has to be checked.
  const codesMatch = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && a.trim().toUpperCase() === b.trim().toUpperCase();

  if (override) {
    for (const candidate of candidates) {
      if (
        codesMatch(candidate.supplier, override.supplier) &&
        codesMatch(candidate.sku, override.supplierSku)
      ) {
        candidate.adminConfirmed = true;
      }
    }
  }

  // An override that was consulted but whose product never came back. The line
  // must not silently look like an ordinary automated match — that is precisely
  // the case where the dashboard would be lying about who decided it.
  const confirmationMissed =
    override !== undefined && !candidates.some((candidate) => candidate.adminConfirmed);

  // Set ONLY when the confirmation was actually missed. A confirmed line can
  // still fail later — a listing with no price is unorderable no matter who
  // approved it — and telling that admin their product "was not returned" when
  // it plainly was would send them looking in the wrong place.
  const missedExplanation =
    confirmationMissed && override
      ? `An admin confirmed ${supplierName(override.supplier)} ${override.supplierSku} for this ` +
        'description, but the supplier did not return that product — this line was matched ' +
        'automatically instead. Re-confirm it if it is still the product you want.'
      : undefined;

  if (candidates.length === 0) {
    return finish(
      {
        ...attention(
          'No supplier found',
          supplierErrors.length > 0
            ? `Supplier search failed: ${supplierErrors.map((e) => e.supplier).join(', ')}.`
            : `Neither supplier returned any product, across ${retrieval.length} query breadth(s) down to "${retrieval.at(-1)?.query ?? query}".`,
        ),
        ...(missedExplanation ? { explanation: missedExplanation } : {}),
      },
      { supplierErrors, retrieval, searchQuery: searchQueryUsed },
    );
  }

  // --- Compound splitting, phase two ---------------------------------------
  //
  // "AIRWAVES BLACKMINT" and "Airwaves Black Mint" are the same product, but the
  // joined spelling matches nothing. Splitting needs a vocabulary, and the only
  // trustworthy vocabulary is the supplier titles for THIS line — which do not
  // exist until after the search. So it runs here, once candidates are back:
  //
  //   search (broad) → vocabulary from candidate titles → split → compare
  //
  // Both sides go through the same splitter, so a split can only ever make two
  // descriptions of one product agree; it cannot merge different products.
  // SUPPLIER titles only. Including the retailer's own text would add its
  // compound ("blackmint") to the vocabulary, and the splitter never takes
  // apart a word it believes is real — so the term would block its own split.
  const vocabulary = vocabularyFor(candidates.map((candidate) => candidate.name));
  const split = splitCompounds(target.description.toLowerCase(), vocabulary);

  if (split.splits.length > 0) {
    target.description = split.text.toUpperCase();
    request.description = target.description;
  }

  // --- SBERT ---------------------------------------------------------------
  // SBERT never sees noisy text. Supplier titles are normalized against that
  // supplier's own decoration list, so "Nestle Std Smarties Hexatube" and
  // "Nestle Smarties Hexatube" encode to the same sentence instead of being
  // scored apart on catalogue style.
  const aiCandidates: AiCandidate[] = candidates.map((candidate) => ({
    supplier: candidate.supplier,
    name:
      normalizeProduct(candidate.name, { supplier: candidate.supplier })
        .normalizedQuery || candidate.name,
    ...(candidate.brand ? { brand: candidate.brand } : {}),
    ...(candidate.unitsPerCase !== undefined ? { unitsPerCase: candidate.unitsPerCase } : {}),
    ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
    ...(candidate.ean ? { ean: candidate.ean } : {}),
    ...(candidate.sku ? { sku: candidate.sku } : {}),
  }));

  const rank = opts.rank ?? rankCandidates;
  const ai = await rank(article.sourceRow, target, aiCandidates);

  // The AI service being down must not silently drop the line. Fall back to
  // neutral similarity so the DETERMINISTIC rules still run — they are what
  // decides correctness anyway — and flag the degradation on the row.
  const ranked =
    ai.ranking.length > 0
      ? ai.ranking
          .filter((entry) => candidates[entry.candidateIndex] !== undefined)
          .map((entry) => ({
            candidateIndex: entry.candidateIndex,
            candidate: candidates[entry.candidateIndex]!,
            similarity: entry.similarity,
          }))
      : candidates.map((candidate, index) => ({
          candidateIndex: index,
          candidate,
          similarity: 0,
        }));

  // --- Rules, selection, reconciliation ------------------------------------
  const judgements = judgeCandidates(target, ranked);
  const ruled = selectFinal(ranked, judgements);

  // Commercial equivalence sits BETWEEN selection and reconciliation.
  //
  // `selectFinal` drops a supplier whose two best candidates are too close to
  // call. That is right when they are different products and wrong when they
  // are one product listed twice under different retail decoration — which,
  // measured on a real order file, was 81 of 112 remaining failures. This stage
  // strips the decoration, and where the survivors are the same commercial
  // product it takes the cheapest instead of asking a human to choose between a
  // product and itself.
  //
  // It only ever ADDS to the selection, and reconciliation still runs on the
  // result, so it can change which candidate is offered but never whether that
  // candidate was verified.
  const equivalence = resolveCommercialEquivalence(
    ruled,
    candidates,
    judgements,
    opts.commercialEquivalence ?? true,
  );
  const selection = equivalence.selection;

  const gate = reconcileSelection(request, selection.selected);

  const base = {
    supplierErrors,
    retrieval,
    searchQuery: searchQueryUsed,
    candidateCount: candidates.length,
    ...(ai.error ? { aiError: ai.error } : {}),
    aiMs: ai.durationMs,
    judgements,
    reconciliations: gate.results,
    equivalence: equivalence.resolutions,
  };

  if (gate.safe.length === 0) {
    // Selected but blocked, or never selected at all — either way, one row.
    const blocked = gate.blocked[0];
    const ambiguous = selection.excluded.find((e) => e.needsAiReview);

    if (blocked) {
      return finish(
        {
          ...attention('Reconciliation failed', blocked.summary, blocked.codes),
          ...(missedExplanation ? { explanation: missedExplanation } : {}),
        },
        base,
      );
    }
    if (ambiguous) {
      // Equivalence was tried and declined: the candidates really are different
      // commercial products, so the explanation says which — a buyer choosing
      // between "Snickers Bar" and "Snickers Duo" needs to know that is the
      // question, not that the matcher was unsure.
      const unresolved = equivalence.resolutions.find(
        (resolution) => !resolution.resolved && resolution.supplier === ambiguous.supplier,
      );
      return finish(
        {
          ...attention('Manual review required', unresolved?.reason ?? ambiguous.reason, []),
          explanation: DIFFERENT_EXPLANATION,
        },
        base,
      );
    }
    return finish(
      {
        ...attention('Manual review required', selection.reason, []),
        ...(missedExplanation ? { explanation: missedExplanation } : {}),
      },
      base,
    );
  }

  // --- Ready to order ------------------------------------------------------
  const offers = gate.safe.map((candidate) => toOffer(candidate));
  const best = chooseBestSupplier(offers);

  if (!best || best.exVatCasePrice === undefined) {
    return finish(
      attention(
        'Reconciliation failed',
        'Reconciled product has no usable price.',
        ['MISSING_PRICE'],
      ),
      base,
    );
  }

  // --- Savings -------------------------------------------------------------
  //
  //   savings = eposMainCost − selectedSupplierExVatCasePrice
  //
  // ONE basis: what the retailer pays today, from the Excel "Cost" column.
  // Never supplier-versus-supplier — that answered "which supplier is dearer",
  // which is not a saving and produced a positive number even when switching
  // would cost the shop MORE. With no cost in the file there is no saving to
  // claim, so the answer is "unknown", not a substitute comparison.
  const baselineCost =
    article.mainCost !== undefined && article.mainCost > 0 ? article.mainCost : undefined;
  const costDelta =
    baselineCost !== undefined ? baselineCost - best.exVatCasePrice : undefined;

  const savingsStatus: ReadyToOrderRow['savingsStatus'] =
    costDelta === undefined ? 'no-baseline' : costDelta > 0 ? 'saving' : 'no-saving';

  // Only a real saving is reported as one. A dearer supplier reports no saving
  // rather than a negative "saving", which read as a discount in the table.
  const savings = savingsStatus === 'saving' ? costDelta : undefined;

  const detail: ProductDetail = {
    requestedProduct: article.description,
    ...(packLabel(article.unitsPerCase, article.unitSize)
      ? { requestedPack: packLabel(article.unitsPerCase, article.unitSize)! }
      : {}),
    selected: best,
    alternatives: commercialAlternatives(request, candidates, judgements, gate.safe),
    offers,
  };

  // Warnings from the reconciliation that cleared the winning supplier. These
  // are what turn a silent pass into "PASS WITH WARNING" on the dashboard.
  const winningResult = gate.results.find(
    (result) => result.supplier === best.supplier && result.passed,
  );
  const warnings = (winningResult?.differences ?? [])
    .filter((difference) => difference.severity === 'warning')
    // A barcode difference is bookkeeping, not something to caveat a buy with.
    .filter((difference) => difference.code !== 'BRAND_MISMATCH')
    .map((difference) => ({
      code: difference.code,
      message: difference.reason,
      ...(difference.overriddenByAdmin ? { overriddenByAdmin: true } : {}),
    }));

  // What the admin decided, as the dashboard needs to state it. `differsFromRequest`
  // is derived from the warnings that were downgraded rather than stored
  // separately, so the badge and the list beneath it can never disagree.
  const adminConfirmed =
    best.adminConfirmed && override
      ? {
          supplier: override.supplier,
          supplierSku: override.supplierSku,
          ...(override.createdByEmail ? { by: override.createdByEmail } : {}),
          differsFromRequest: warnings.some((warning) => warning.overriddenByAdmin),
        }
      : undefined;

  const row: ReadyToOrderRow = {
    kind: 'ready',
    warnings,
    ...(adminConfirmed ? { adminConfirmed } : {}),
    // A confirmation that could not be honoured outranks the equivalence note:
    // one explains a decision the pipeline made, the other says a human's
    // decision was not applied, and only the second needs acting on.
    ...(missedExplanation
      ? { explanation: missedExplanation }
      : equivalence.explanation
        ? { explanation: equivalence.explanation }
        : {}),
    row: article.sourceRow,
    articleCode: article.articleCode,
    product: article.description,
    bestSupplier: best.supplier,
    bestSupplierName: best.supplierName,
    price: best.exVatCasePrice,
    cases: article.cases,
    addedToCart: 'No',
    detail,
    savingsStatus,
    ...(savings !== undefined && Number.isFinite(savings) ? { savings } : {}),
    ...(savings !== undefined && baselineCost
      ? { savingsPct: savings / baselineCost }
      : {}),
    ...(baselineCost !== undefined ? { baselineCost } : {}),
    ...(costDelta !== undefined && Number.isFinite(costDelta) ? { costDelta } : {}),
  };

  return finish(row, base);
}
