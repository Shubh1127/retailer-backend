/**
 * Calibrated match confidence.
 *
 * `pickBestMatch` (connectors/match.ts) answers "which of these search results
 * is most likely the one?" — a RANKING score. It is not a probability, and it
 * cannot be thresholded at 0.90: its name term penalizes every extra token on
 * the supplier side by 0.2 (capped at 0.7), so a genuinely correct match scores
 * far below 0.9. Worked example, real Musgrave data:
 *
 *   EPOS "SMARTIES HEXATUBE" (24 X 38.000)
 *   card "Nestle Smarties Hexatube" 24 x 38 g
 *     packScore 1.0, coverage 1.0, 4 extra tokens → penalty 0.7 → name 0.30
 *     score = 0.6·1.0 + 0.4·0.30 = 0.72
 *
 * So ranking and acceptance are separated. `pickBestMatch` keeps doing the
 * ranking (unchanged); this module decides whether the winner is safe to put on
 * a purchase order, on a scale where "≥0.90" is a claim you can defend:
 *
 *   HARD GATES (all must hold, else the match can never be auto-accepted)
 *     G1 pack known      — both sides expose units-per-case AND unit size
 *     G2 pack exact      — units-per-case equal, unit size within max(0.5, 2%)
 *     G3 no variant clash — no DARK/WHITE/DIET/ZERO/flavour token on exactly one
 *                          side. This, not raw token count, is what separates
 *                          "Kinder Bueno" from "Kinder Bueno Dark".
 *     G4 clear margin    — the winner beats the runner-up by ≥0.12, mirroring
 *                          `pickBestMatch`'s own ambiguity rule
 *
 *   SOFT SIGNALS (only inside the gates, mapped into a narrow band)
 *     name  — size-token-STRIPPED bidirectional overlap. Numerals and measures
 *             are dropped because G2 already scored the pack; double-counting it
 *             is exactly what crushes correct matches under the ranking score.
 *     brand — EPOS description vs the card's brand/manufacturer field
 *     price — supplier case price vs the EPOS "Cost" baseline. Valid to compare
 *             directly because G2 has already proven the packs are identical.
 *     margin— how unambiguous the win was
 *
 *   BOOSTERS
 *     A known-EAN hit, or two suppliers independently reporting the SAME
 *     GTIN-14 for one EPOS line, is near-proof and lifts confidence to ≥0.96.
 *
 * Every component is returned in the breakdown so a rejection is explainable and
 * the weights can be tuned against a real listing rather than guessed at.
 */

import { parseSizeText, type SearchCard } from '../connectors/types.js';
import type { MatchDecision, MatchTarget, ScoredCandidate } from '../connectors/match.js';
import { toExVat } from '../pricing/normalize.js';
import { GtinError, normalizeToGtin14 } from '../gtin.js';
import type { PriceQuote } from '../types.js';

/** Default acceptance threshold — the "approximately 90-95%" bar. */
export const DEFAULT_MIN_CONFIDENCE = 0.9;
/**
 * Below the accept threshold but worth a human look. Kept as a first-class
 * bucket: with a 0.90 gate, silently discarding near-misses would quietly drop
 * real order lines.
 */
export const REVIEW_FLOOR = 0.7;

/** Unit-size tolerance: exact units-per-case, unit size within max(0.5, 2%). */
export const PACK_ABS_TOLERANCE = 0.5;
export const PACK_REL_TOLERANCE = 0.02;
/** Runner-up margin needed to call the win unambiguous (cf. match.ts:109). */
const CLEAR_MARGIN = 0.12;
/** Margin at which the ambiguity bonus saturates. */
const MARGIN_SATURATION = 0.3;

/**
 * Price agreement band. Deliberately wide: a supplier being much cheaper is the
 * POINT of this product, so price is only evidence of a bad match at
 * order-of-magnitude deviation (a unit price read as a case price, a 6-pack
 * priced as a 24-case). Within 25% scores full marks; 150% out scores zero.
 */
const PRICE_FULL_CREDIT = 0.25;
const PRICE_NO_CREDIT = 1.5;

/** Signal weights inside the gates. Sum to 1. */
const W_NAME = 0.62;
const W_BRAND = 0.15;
const W_PRICE = 0.13;
const W_MARGIN = 0.1;

/** Gated candidates map onto [0.72, 0.98]. */
const GATED_FLOOR = 0.72;
const GATED_RANGE = 0.26;
/**
 * Gate-failing candidates map onto [0.45, 0.85] — high enough to surface for
 * review, never high enough to auto-accept. That ceiling is the whole point:
 * a failed gate means a human decides.
 */
const UNGATED_FLOOR = 0.45;
const UNGATED_RANGE = 0.4;

/**
 * Nothing is ever certain: a supplier can state a pack and an EAN and still be
 * listing the wrong product. 1.0 is deliberately unreachable.
 */
export const CONFIDENCE_CEILING = 0.99;
export const CROSS_SUPPLIER_EAN_FLOOR = 0.96;

/** Words carrying no product identity. */
const STOP = new Set([
  'the', 'a', 'of', 'and', '&', 'with', 'in', 'for',
  'case', 'cs', 'pmp', 'pm', 'ea', 'each', 'std', 'standard', 'pack', 'pk',
]);

/**
 * Variant detection works on two classes of word, because "flavour word" covers
 * two different things:
 *
 *   "Nutella"      vs "Nutella Hazelnut Spread"  → SAME    (hazelnut describes it)
 *   "Coca-Cola"    vs "Coca-Cola Zero"           → DIFFERENT
 *   "Fairy Original" vs "Fairy Lemon"            → DIFFERENT
 *
 * The first two are structurally identical — one extra word on the supplier side
 * — so no single list can separate them. What separates them is the CLASS of
 * word, and one asymmetry: the MARKED form is the variant, the DEFAULT form is
 * merely descriptive.
 */

/**
 * Marked formulations. Their presence on one side only is decisive: an order
 * line that does not say "Zero" wants the regular product. "Dark"/"white"
 * chocolate and "unsalted" butter are marked forms of a default in the same way.
 *
 * Note the deliberate asymmetry — "unsalted" is here, "salted" is a descriptor,
 * because salted is the default and saying so adds no information.
 */
export const FORMULATION_TOKENS = new Set([
  'zero', 'diet', 'light', 'lite', 'sugarfree', 'caffeinefree', 'decaf',
  'alcoholfree', 'glutenfree', 'lactosefree', 'fatfree', 'dairyfree',
  // Canonical forms produced by config/normalization.json's synonym map. These
  // MUST stay in step with that file: a synonym that canonicalises to a token
  // missing here is no longer recognised as a formulation, and the product
  // parser leaves it sitting in the product identity instead of the variant.
  'nosugar',
  'dark', 'white', 'unsalted',
]);

/**
 * Flavours and qualifiers. Ambiguous on their own: "Hazelnut" on a Nutella line
 * describes the product, while "Lemon" on a Fairy line distinguishes it from
 * "Original". So these only conflict when BOTH sides name one and each names one
 * the other does not — a genuine head-to-head between two named flavours.
 *
 * Because one-sided descriptors are harmless under that rule, this list can be
 * generous without causing false rejections.
 */
export const DESCRIPTOR_TOKENS = new Set([
  'original', 'classic', 'regular', 'plain',
  'hazelnut', 'lemon', 'lime', 'orange', 'cherry', 'vanilla', 'strawberry', 'raspberry',
  'blackcurrant', 'mint', 'caramel', 'coconut', 'banana', 'apple', 'toffee', 'fudge',
  'chocolate', 'cheese', 'onion', 'vinegar', 'bbq', 'paprika', 'chilli', 'garlic', 'herb',
  'salted', 'smoked', 'spicy', 'mild', 'hot',
  'mini', 'king', 'share', 'multipack',
]);

/** A bare number, or a number glued to a unit ("330ml", "38g", "2l"), or "x". */
const MEASURE_TOKEN_RE = /^(?:\d+(?:\.\d+)?(?:ml|cl|l|lt|ltr|g|kg|gr)?|x)$/;

/** Does this text actually state a pack, or is it just a bare size / nothing? */
const PACK_TEXT_RE = /\d\s*[xX×]\s*\d|\d\s*[a-zA-Z]+\s*\/\s*\d/;

/**
 * Identity-bearing tokens: lowercased, punctuation stripped, stop words and
 * measure tokens removed. Multi-word variants are glued first so "sugar free"
 * survives tokenization as one signal.
 */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/no\s+added\s+sugar/g, 'sugarfree')
    .replace(/zero\s+sugar/g, 'zero')
    .replace(/sugar\s*free/g, 'sugarfree')
    .replace(/caffeine\s*free/g, 'caffeinefree')
    .replace(/alcohol\s*free/g, 'alcoholfree')
    .replace(/gluten\s*free/g, 'glutenfree')
    .replace(/lactose\s*free/g, 'lactosefree')
    .replace(/fat\s*free/g, 'fatfree')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t) && !MEASURE_TOKEN_RE.test(t));
}

/** Fraction of `wanted` present in `have`. */
function coverage(wanted: readonly string[], have: ReadonlySet<string>): number {
  if (wanted.length === 0) return 0;
  let hit = 0;
  for (const t of wanted) if (have.has(t)) hit++;
  return hit / wanted.length;
}

/** Sørensen–Dice overlap of two token sets. */
function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/**
 * Name agreement, weighted toward covering the EPOS words (a supplier adding a
 * brand prefix is normal) but still rewarding overall similarity so a card that
 * buries the EPOS name inside a much longer title doesn't score full marks.
 */
export function nameAgreement(eposDescription: string, cardName: string): number {
  const wanted = contentTokens(eposDescription);
  const have = contentTokens(cardName);
  if (wanted.length === 0 || have.length === 0) return 0;
  const haveSet = new Set(have);
  return 0.7 * coverage(wanted, haveSet) + 0.3 * dice(new Set(wanted), haveSet);
}

/**
 * Words indicating the two names describe different products.
 *
 *  - A FORMULATION token on one side only is decisive ("Zero", "Dark", "Decaf").
 *  - DESCRIPTOR tokens conflict only when each side names one the other does not,
 *    so "Nutella" ↔ "Nutella Hazelnut Spread" passes while "Fairy Original" ↔
 *    "Fairy Lemon" does not. A pure subset ("Cheese" ⊂ "Cheese & Onion") is
 *    treated as less specific, not contradictory.
 */
export function variantConflicts(eposDescription: string, cardName: string): string[] {
  const left = contentTokens(eposDescription);
  const right = contentTokens(cardName);
  const conflicts: string[] = [];

  const leftFormulation = new Set(left.filter((t) => FORMULATION_TOKENS.has(t)));
  const rightFormulation = new Set(right.filter((t) => FORMULATION_TOKENS.has(t)));
  for (const token of leftFormulation) if (!rightFormulation.has(token)) conflicts.push(token);
  for (const token of rightFormulation) if (!leftFormulation.has(token)) conflicts.push(token);

  const leftDescriptors = new Set(left.filter((t) => DESCRIPTOR_TOKENS.has(t)));
  const rightDescriptors = new Set(right.filter((t) => DESCRIPTOR_TOKENS.has(t)));
  const onlyLeft = [...leftDescriptors].filter((t) => !rightDescriptors.has(t));
  const onlyRight = [...rightDescriptors].filter((t) => !leftDescriptors.has(t));

  // Both sides naming a flavour the other lacks is a head-to-head mismatch.
  // One side alone is just a more descriptive name for the same thing.
  if (onlyLeft.length > 0 && onlyRight.length > 0) {
    conflicts.push(...onlyLeft, ...onlyRight);
  }

  return [...new Set(conflicts)].sort();
}

/**
 * Brand agreement — a bonus only, never a penalty.
 *
 * The card's brand field is a MANUFACTURER ("Nestle") while EPOS descriptions use
 * terse product names ("SMARTIES HEXATUBE"). Its absence from the description is
 * completely normal, so a non-overlap is neutral, not evidence against the match.
 * O'Reilly exposes no brand at all, which is neutral for the same reason.
 */
export function brandAgreement(eposDescription: string, cardBrand: string | undefined): number {
  const brandTokens = contentTokens(cardBrand ?? '');
  if (brandTokens.length === 0) return 0.5; // unknown → neutral
  const eposSet = new Set(contentTokens(eposDescription));
  const hit = brandTokens.filter((t) => eposSet.has(t)).length;
  if (hit === brandTokens.length) return 1;
  if (hit > 0) return 0.75;
  return 0.5; // manufacturer simply not named in the EPOS description
}

/** Pack as stated by the card: structured fields first, then the size text. */
export function packOfCard(
  card: SearchCard,
): { unitsPerCase: number; unitSize: number } | undefined {
  if (card.unitsPerCase && card.unitSize) {
    return { unitsPerCase: card.unitsPerCase, unitSize: card.unitSize };
  }
  const text = card.sizeText ?? '';
  if (!PACK_TEXT_RE.test(text)) return undefined; // no pack stated — not a 1x1 pack
  const parsed = parseSizeText(text);
  if (!parsed.unitsPerCase || !parsed.unitSize) return undefined;
  return { unitsPerCase: parsed.unitsPerCase, unitSize: parsed.unitSize };
}

/**
 * Pack comparison, with units-per-case and unit size judged SEPARATELY.
 *
 * G2 needs only the combined `exact`, but the two halves answer different
 * questions — "is this the same case configuration?" versus "is this the same
 * product size?" — and a 4-pack of 34 g tubes fails both for different reasons.
 * The rule engine reports them individually, so the split lives here next to the
 * tolerances rather than being re-derived by each caller.
 */
export interface PackComparison {
  /** Both sides stated a pack at all. */
  known: boolean;
  /** Units-per-case are equal. */
  unitsPerCaseMatch: boolean;
  /** Unit size agrees within tolerance. */
  unitSizeMatch: boolean;
  /** Both of the above — this is G2. */
  exact: boolean;
  /** The absolute tolerance actually applied to the unit size. */
  unitSizeTolerance?: number;
}

export function comparePack(
  target: { unitsPerCase?: number; unitSize?: number },
  cardPack: { unitsPerCase: number; unitSize: number } | undefined,
): PackComparison {
  if (!cardPack || !target.unitsPerCase || !target.unitSize) {
    return { known: false, unitsPerCaseMatch: false, unitSizeMatch: false, exact: false };
  }
  const unitSizeTolerance = Math.max(PACK_ABS_TOLERANCE, target.unitSize * PACK_REL_TOLERANCE);
  const unitsPerCaseMatch = cardPack.unitsPerCase === target.unitsPerCase;
  const unitSizeMatch = Math.abs(cardPack.unitSize - target.unitSize) <= unitSizeTolerance;
  return {
    known: true,
    unitsPerCaseMatch,
    unitSizeMatch,
    exact: unitsPerCaseMatch && unitSizeMatch,
    unitSizeTolerance,
  };
}

/**
 * Price agreement against the EPOS cost baseline. Only meaningful once the
 * packs are known identical (G2), which is why it compares case prices directly
 * instead of deriving a per-base-unit price — the EPOS export carries no unit of
 * measure at all.
 */
export function priceAgreement(
  eposMainCost: number | undefined,
  supplierExVatCasePrice: number | undefined,
): number {
  if (
    !eposMainCost ||
    eposMainCost <= 0 ||
    supplierExVatCasePrice === undefined ||
    !Number.isFinite(supplierExVatCasePrice) ||
    supplierExVatCasePrice <= 0
  ) {
    return 0.5; // no comparable basis → neutral
  }
  const rel = Math.abs(supplierExVatCasePrice - eposMainCost) / eposMainCost;
  if (rel <= PRICE_FULL_CREDIT) return 1;
  if (rel >= PRICE_NO_CREDIT) return 0;
  return 1 - (rel - PRICE_FULL_CREDIT) / (PRICE_NO_CREDIT - PRICE_FULL_CREDIT);
}

/** Normalize a card's EAN to a canonical GTIN-14, or undefined if unusable. */
export function cardGtin(card: SearchCard): string | undefined {
  const raw = card.eanText?.trim();
  if (!raw) return undefined;
  try {
    return normalizeToGtin14(raw);
  } catch (e) {
    if (e instanceof GtinError) return undefined;
    throw e;
  }
}

export interface ConfidenceBreakdown {
  /** G1 — both sides stated a pack. */
  packKnown: boolean;
  /** G2 — units-per-case equal and unit size within tolerance. */
  packExact: boolean;
  /** G3 — variant tokens appearing on only one side (empty is good). */
  variantConflicts: string[];
  /** G4 — winner's lead over the runner-up, and whether it clears the bar. */
  margin: number;
  clearMargin: boolean;
  /** True when every gate held. Only then can confidence reach the threshold. */
  gatesPassed: boolean;
  nameScore: number;
  brandScore: number;
  priceScore: number;
  marginScore: number;
  /** Weighted soft-signal total, 0..1. */
  base: number;
  /** Confidence before boosters. */
  gatedConfidence: number;
  /** Booster labels applied, e.g. "cross-supplier-ean". */
  boosters: string[];
  /** The supplier case price used for the price signal, ex-VAT. */
  supplierExVatCasePrice?: number;
  /** The EPOS cost baseline used for the price signal. */
  eposMainCost?: number;
}

export interface ConfidenceResult {
  confidence: number;
  breakdown: ConfidenceBreakdown;
  /** Human-readable explanation — the accept reason, or why it was gated. */
  reason: string;
}

export interface ConfidenceInput {
  /** What the EPOS line is asking for. */
  target: MatchTarget;
  /** The full ranking decision — supplies the runner-up margin. */
  decision: MatchDecision;
  /** The candidate being scored (normally `decision.best`). */
  candidate: ScoredCandidate;
  /** That candidate's normalized quote, for the price sanity signal. */
  quote?: PriceQuote;
  /** The EPOS "Cost" column — the shop's current cost per case. */
  eposMainCost?: number;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function gateReason(b: ConfidenceBreakdown): string {
  if (!b.packKnown) {
    return 'Pack size not stated on both sides — cannot verify this is the same pack.';
  }
  if (!b.packExact) {
    return 'Pack size differs from the EPOS line — likely a different pack of the same product.';
  }
  if (b.variantConflicts.length > 0) {
    return `Variant mismatch (${b.variantConflicts.join(', ')}) — likely a different flavour/version.`;
  }
  if (!b.clearMargin) {
    return 'Two candidates score almost the same — genuinely ambiguous, needs a human.';
  }
  return 'Gates passed.';
}

/**
 * Score one ranked candidate for acceptance. Pure and deterministic — no clock,
 * no network — so it is unit-testable against recorded supplier cards.
 */
export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const { target, decision, candidate, quote, eposMainCost } = input;
  const card = candidate.card;

  // --- Gates -------------------------------------------------------------
  const cardPack = packOfCard(card);
  const pack = comparePack(target, cardPack);
  const packKnown = pack.known;
  const packExact = pack.exact;

  const conflicts = variantConflicts(target.description, card.name);

  const runnerUp = decision.ranked.find((c) => c !== candidate);
  const margin = runnerUp ? candidate.score - runnerUp.score : 1;
  const clearMargin = margin >= CLEAR_MARGIN;

  const gatesPassed = packKnown && packExact && conflicts.length === 0 && clearMargin;

  // --- Soft signals ------------------------------------------------------
  const nameScore = nameAgreement(target.description, card.name);
  const brandScore = brandAgreement(target.description, card.brand);
  const supplierExVatCasePrice = quote
    ? toExVat(quote.rawCasePrice, quote.vatRate, quote.priceIsVatInclusive)
    : undefined;
  const priceScore = priceAgreement(eposMainCost, supplierExVatCasePrice);
  const marginScore = Math.min(1, Math.max(0, margin) / MARGIN_SATURATION);

  const base =
    W_NAME * nameScore + W_BRAND * brandScore + W_PRICE * priceScore + W_MARGIN * marginScore;

  const confidence = gatesPassed
    ? GATED_FLOOR + GATED_RANGE * base
    : Math.min(UNGATED_FLOOR + UNGATED_RANGE * base, UNGATED_FLOOR + UNGATED_RANGE);

  const breakdown: ConfidenceBreakdown = {
    packKnown,
    packExact,
    variantConflicts: conflicts,
    margin: round3(margin),
    clearMargin,
    gatesPassed,
    nameScore: round3(nameScore),
    brandScore: round3(brandScore),
    priceScore: round3(priceScore),
    marginScore: round3(marginScore),
    base: round3(base),
    gatedConfidence: round3(confidence),
    boosters: [],
    ...(supplierExVatCasePrice !== undefined
      ? { supplierExVatCasePrice: round3(supplierExVatCasePrice) }
      : {}),
    ...(eposMainCost !== undefined ? { eposMainCost } : {}),
  };

  return {
    confidence: round3(confidence),
    breakdown,
    reason: gatesPassed
      ? `Pack verified ${cardPack?.unitsPerCase}×${cardPack?.unitSize}, no variant conflict, unambiguous winner.`
      : gateReason(breakdown),
  };
}

/** Boosters that only a cross-candidate view can apply. */
export type ConfidenceBooster = 'known-ean' | 'cross-supplier-ean';

/**
 * Raise confidence on independent identity evidence. Two suppliers returning the
 * SAME GTIN-14 for one EPOS description is far stronger than either name match
 * alone, so it can lift a gate-failing candidate — the gate exists because pack
 * text is unreliable, and an agreeing EAN settles the question the gate was
 * asking. Recorded in `boosters` either way so the lift is always auditable.
 */
export function applyConfidenceBooster(
  result: ConfidenceResult,
  booster: ConfidenceBooster,
): ConfidenceResult {
  const floor = booster === 'known-ean' ? CONFIDENCE_CEILING : CROSS_SUPPLIER_EAN_FLOOR;
  const boosted = Math.min(CONFIDENCE_CEILING, Math.max(result.confidence, floor));
  if (boosted === result.confidence && result.breakdown.boosters.includes(booster)) {
    return result;
  }
  const boosters = result.breakdown.boosters.includes(booster)
    ? result.breakdown.boosters
    : [...result.breakdown.boosters, booster];
  return {
    confidence: round3(boosted),
    breakdown: { ...result.breakdown, boosters },
    reason:
      booster === 'cross-supplier-ean'
        ? 'Both suppliers report the same EAN for this line — identity confirmed independently.'
        : 'Supplier EAN matches the known barcode for this line.',
  };
}

export type MatchBucket = 'matched' | 'needs-review' | 'unmatched';

/** Which bucket a confidence lands in. */
export function bucketFor(
  confidence: number,
  minConfidence: number = DEFAULT_MIN_CONFIDENCE,
): MatchBucket {
  if (confidence >= minConfidence) return 'matched';
  if (confidence >= REVIEW_FLOOR) return 'needs-review';
  return 'unmatched';
}
