/**
 * Match retailer order lines against the LOCAL Musgrave catalogue.
 *
 * No network: candidates come from `musgrave_products` only. Ranking and
 * acceptance reuse the production matching code unchanged —
 * `pickBestMatch` (connectors/match.ts) to rank, `scoreConfidence`
 * (services/matchConfidence.ts) to decide — so whatever this measures is what
 * production will do once the same resolver is wired in.
 *
 * The catalogue runs to tens of thousands of rows and every order line has to be
 * compared against it, so a token index narrows the field first. Scoring every
 * product for every line would be correct but needlessly slow; the index only
 * decides which candidates get scored, never which one wins.
 *
 * NOTE: local rows carry no EAN today (it sits unpromoted inside `raw_product`),
 * so the EAN confidence boosters never fire here. Local confidence is therefore a
 * slight UNDER-estimate of what a fully promoted catalogue would score.
 */

import { normalizeCard, type SearchCard } from '../connectors/types.js';
import { pickBestMatch, type MatchTarget } from '../connectors/match.js';
import {
  bucketFor,
  contentTokens,
  scoreConfidence,
  DEFAULT_MIN_CONFIDENCE,
  type ConfidenceBreakdown,
  type MatchBucket,
} from './matchConfidence.js';
import type { CatalogueProductRow } from '../repositories/musgraveProduct.repository.js';
import type { ShopArticle } from '../ingest/eposListing.js';

/** Candidates scored per line. Beyond this the ranking has long since decided. */
const DEFAULT_MAX_CANDIDATES = 60;
/** How many scored candidates to return for reporting. */
const DEFAULT_REPORT_DEPTH = 3;
/**
 * A token appearing in more than this fraction of the catalogue ("pack", "ml")
 * says nothing about identity and would drag in most of the catalogue.
 */
const COMMON_TOKEN_FRACTION = 0.05;

/** Build a comparable card from a stored catalogue row. */
export function catalogueRowToSearchCard(row: CatalogueProductRow): SearchCard {
  return {
    supplierSku: row.sku,
    name: row.name,
    priceText: row.salePrice !== undefined ? `${row.salePrice}` : '',
    priceIncludesVat: false,
    ...(row.manufacturer ? { brand: row.manufacturer } : {}),
    ...(row.size ? { sizeText: row.size } : {}),
    ...(row.taxRate !== undefined ? { vatText: `${row.taxRate * 100}%` } : {}),
    ...(row.uri ? { productUrl: row.uri } : {}),
  };
}

export interface CatalogueIndex {
  rows: CatalogueProductRow[];
  cards: SearchCard[];
  /** Identity token → indices of rows whose name contains it. */
  byToken: Map<string, number[]>;
  /** Postings longer than this are too common to narrow with. */
  commonTokenCutoff: number;
}

/** Tokenize the catalogue once so every line can be matched cheaply. */
export function buildCatalogueIndex(rows: readonly CatalogueProductRow[]): CatalogueIndex {
  const cards: SearchCard[] = [];
  const byToken = new Map<string, number[]>();

  rows.forEach((row, index) => {
    cards.push(catalogueRowToSearchCard(row));
    for (const token of new Set(contentTokens(row.name))) {
      const postings = byToken.get(token);
      if (postings) postings.push(index);
      else byToken.set(token, [index]);
    }
  });

  return {
    rows: [...rows],
    cards,
    byToken,
    commonTokenCutoff: Math.max(50, Math.floor(rows.length * COMMON_TOKEN_FRACTION)),
  };
}

/**
 * Narrow the catalogue to the rows sharing the most identity tokens with the
 * description. Rare tokens are used first; if they yield nothing, common tokens
 * are allowed back in rather than giving up.
 */
export function selectCandidates(
  description: string,
  index: CatalogueIndex,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
): number[] {
  const tokens = new Set(contentTokens(description));
  if (tokens.size === 0) return [];

  const gather = (allowCommon: boolean): Map<number, number> => {
    const hits = new Map<number, number>();
    for (const token of tokens) {
      const postings = index.byToken.get(token);
      if (!postings) continue;
      if (!allowCommon && postings.length > index.commonTokenCutoff) continue;
      for (const row of postings) hits.set(row, (hits.get(row) ?? 0) + 1);
    }
    return hits;
  };

  let hits = gather(false);
  if (hits.size === 0) hits = gather(true);

  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, maxCandidates)
    .map(([row]) => row);
}

export interface LocalMatchCandidate {
  sku: string;
  name: string;
  brand?: string;
  sizeText?: string;
  unitsPerCase?: number;
  unitSize?: number;
  exVatCasePrice?: number;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  reason: string;
}

export interface LocalMatchResult {
  article: ShopArticle;
  /** Scored candidates, strongest first. Empty when nothing plausible was found. */
  ranked: LocalMatchCandidate[];
  best?: LocalMatchCandidate;
  bucket: MatchBucket;
  accepted: boolean;
  candidatesConsidered: number;
}

export interface LocalMatchOptions {
  minConfidence?: number;
  maxCandidates?: number;
  reportDepth?: number;
}

/** Name agreement below which the "best" candidate isn't really the product. */
const WEAK_NAME_AGREEMENT = 0.45;

export type MatchOutcome =
  | 'matched'
  /** Nothing in the catalogue shared an identifying word. */
  | 'no-candidate'
  /** Candidates existed but none resembled the product. */
  | 'no-comparable-product'
  /** Right product family, wrong variant (Dark vs plain, Zero vs regular). */
  | 'variant-mismatch'
  /** The catalogue row states no pack, so the pack gate cannot be evaluated. */
  | 'pack-unknown-in-catalogue'
  /** Same product, a pack size we do not hold. */
  | 'pack-size-mismatch'
  /** Two candidates scored too close to separate safely. */
  | 'ambiguous'
  | 'other';

/**
 * Where the fix lies — the point of the classification.
 *
 *  catalogue → sync more products, or promote missing fields
 *  matcher   → tune the matching / confidence logic
 *  correct   → the rejection is right; these are genuinely different products
 */
export type MatchAttribution = 'matched' | 'catalogue' | 'matcher' | 'correct';

export interface MatchClassification {
  outcome: MatchOutcome;
  attribution: MatchAttribution;
  label: string;
}

const CLASSIFICATION_LABELS: Record<MatchOutcome, string> = {
  matched: 'Matched',
  'no-candidate': 'No local catalogue candidate',
  'no-comparable-product': 'Candidates found, none comparable',
  'variant-mismatch': 'Same brand, different variant',
  'pack-unknown-in-catalogue': 'Catalogue row has no pack size',
  'pack-size-mismatch': 'Same product, pack-size mismatch',
  ambiguous: 'Ambiguous (multiple similar candidates)',
  other: 'Below threshold, no single dominant reason',
};

const ATTRIBUTIONS: Record<MatchOutcome, MatchAttribution> = {
  matched: 'matched',
  'no-candidate': 'catalogue',
  'no-comparable-product': 'catalogue',
  // The exact variant/pack is simply not in what we hold locally.
  'variant-mismatch': 'correct',
  'pack-unknown-in-catalogue': 'catalogue',
  'pack-size-mismatch': 'catalogue',
  ambiguous: 'matcher',
  other: 'matcher',
};

/**
 * Explain why a line did not match, so coverage problems can be told apart from
 * matching problems. Checks run most-specific first: a line can trip several
 * gates, and the first one that fires is the one worth acting on.
 */
export function classifyLocalMatch(result: LocalMatchResult): MatchClassification {
  const classify = (outcome: MatchOutcome): MatchClassification => ({
    outcome,
    attribution: ATTRIBUTIONS[outcome],
    label: CLASSIFICATION_LABELS[outcome],
  });

  if (result.accepted) return classify('matched');
  if (result.candidatesConsidered === 0 || !result.best) return classify('no-candidate');

  const { breakdown } = result.best;

  if (breakdown.nameScore < WEAK_NAME_AGREEMENT) return classify('no-comparable-product');
  if (breakdown.variantConflicts.length > 0) return classify('variant-mismatch');
  if (!breakdown.packKnown) return classify('pack-unknown-in-catalogue');
  if (!breakdown.packExact) return classify('pack-size-mismatch');
  if (!breakdown.clearMargin) return classify('ambiguous');

  return classify('other');
}

/** Match one order line against the local catalogue. Pure and deterministic. */
export function matchArticleLocally(
  article: ShopArticle,
  index: CatalogueIndex,
  options: LocalMatchOptions = {},
): LocalMatchResult {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const reportDepth = options.reportDepth ?? DEFAULT_REPORT_DEPTH;

  const target: MatchTarget = {
    description: article.description,
    ...(article.unitsPerCase ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize ? { unitSize: article.unitSize } : {}),
  };

  const candidateRows = selectCandidates(article.description, index, options.maxCandidates);
  const cards = candidateRows.map((row) => index.cards[row]!);

  if (cards.length === 0) {
    return { article, ranked: [], bucket: 'unmatched', accepted: false, candidatesConsidered: 0 };
  }

  const rowOfCard = new Map<SearchCard, number>();
  candidateRows.forEach((row, i) => rowOfCard.set(cards[i]!, row));

  const decision = pickBestMatch(target, cards);

  const ranked: LocalMatchCandidate[] = [];
  for (const scored of decision.ranked.slice(0, reportDepth)) {
    const row = index.rows[rowOfCard.get(scored.card)!]!;
    // Reuse the connector normalization so the price signal sees the same
    // ex-VAT case price production would.
    const { quote, match } = normalizeCard(scored.card, {
      supplierId: 'musgrave',
      unitGtin: '',
      capturedAt: '1970-01-01T00:00:00.000Z',
    });

    const confidence = scoreConfidence({
      target,
      decision,
      candidate: scored,
      quote,
      ...(article.mainCost !== undefined ? { eposMainCost: article.mainCost } : {}),
    });

    ranked.push({
      sku: row.sku,
      name: row.name,
      confidence: confidence.confidence,
      breakdown: confidence.breakdown,
      reason: confidence.reason,
      ...(row.manufacturer ? { brand: row.manufacturer } : {}),
      ...(row.size ? { sizeText: row.size } : {}),
      ...(match.caseConfig.unitsPerCase ? { unitsPerCase: match.caseConfig.unitsPerCase } : {}),
      ...(match.caseConfig.unitSize ? { unitSize: match.caseConfig.unitSize } : {}),
      ...(confidence.breakdown.supplierExVatCasePrice !== undefined
        ? { exVatCasePrice: confidence.breakdown.supplierExVatCasePrice }
        : {}),
    });
  }

  const best = ranked[0];
  const bucket = best ? bucketFor(best.confidence, minConfidence) : 'unmatched';

  return {
    article,
    ranked,
    bucket,
    accepted: bucket === 'matched',
    candidatesConsidered: candidateRows.length,
    ...(best ? { best } : {}),
  };
}
