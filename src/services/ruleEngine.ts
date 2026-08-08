/**
 * Deterministic rule engine — the structured-attribute stage after SBERT.
 *
 *   Excel product → supplier search → SBERT ranking → RULE ENGINE → final confidence
 *
 * Why this exists
 * ---------------
 * SBERT ranks by meaning, and meaning does not distinguish commercial products.
 * Measured on real Musgrave data for one EPOS line:
 *
 *   "SMARTIES HEXATUBE" (24 × 38)
 *     Nestle Smarties Hexatube        24 × 38  →  0.8693   correct
 *     Smarties Hexatube 4 Pack         4 × 34  →  0.7868   wrong product
 *     Smarties Hexatube 3 Pack         3 × 34  →  0.7856   wrong product
 *
 * A 0.08 spread cannot carry a purchase order. The numbers 24, 38, 4 and 3 can:
 * they are exact, they are stated by both sides, and they have one right answer.
 * That is what this module compares.
 *
 * Division of labour
 * ------------------
 * This engine compares STRUCTURED attributes only — quantities, sizes, units of
 * measure, multipack counts and container form factors. It contains no
 * product-specific vocabulary: no "Zero", "Diet", "Lemon", "Mint", "Hazelnut" or
 * "Original". Those are semantic variants and stay with the AI layer, which is
 * why `variantConflicts` (FORMULATION_TOKENS / DESCRIPTOR_TOKENS in
 * `matchConfidence.ts`) is deliberately NOT invoked here.
 *
 * The one vocabulary this file does carry — container form factors — is
 * product-agnostic: "bottle", "can", "bag" and "box" describe packaging, not
 * flavour, and the list is closed and finite in a way a flavour list can never be.
 *
 * Reuse
 * -----
 * Nothing already solved is re-solved. This module builds on:
 *   comparePack        (matchConfidence)  units-per-case + unit size, split, with tolerances
 *   packOfCard         (matchConfidence)  pack extraction that refuses to invent a 1×1
 *   priceAgreement     (matchConfidence)  wide-band price sanity
 *   brandAgreement     (matchConfidence)  brand as a bonus, never a penalty
 *   cardGtin           (matchConfidence)  EAN → canonical GTIN-14
 *   bucketFor          (matchConfidence)  the 0.90 / 0.70 thresholds
 *   caseBaseQuantity   (pricing/normalize) uom families and g/kg/ml/L conversion
 *
 * Tri-state, not boolean
 * ----------------------
 * Every rule answers pass / fail / UNKNOWN. The distinction matters: the EPOS
 * export states no unit of measure at all ("24 X 38.000" — 38 of what?), so a
 * unit rule that returned `false` there would reject every line in the file. An
 * unverifiable rule must lower confidence, never condemn.
 */

import {
  brandAgreement,
  bucketFor,
  comparePack,
  CONFIDENCE_CEILING,
  contentTokens,
  CROSS_SUPPLIER_EAN_FLOOR,
  DEFAULT_MIN_CONFIDENCE,
  PACK_ABS_TOLERANCE,
  PACK_REL_TOLERANCE,
  packOfCard,
  priceAgreement,
  cardGtin,
} from './matchConfidence.js';
import { caseBaseQuantity } from '../pricing/normalize.js';
import {
  normalizedIdentity,
  normalizeProduct,
} from '../normalization/productNormalization.js';
import { getMatchingConfig } from '../normalization/matchingConfig.js';
import { categoryOf } from '../parsing/tokenCategory.js';
import type { SearchCard } from '../connectors/types.js';
import type { Uom } from '../types.js';

// ---- Inputs ---------------------------------------------------------------

/** The Excel line being matched. */
export interface RuleTarget {
  description: string;
  unitsPerCase?: number;
  unitSize?: number;
  /**
   * Container form factor, when known.
   *
   * Required as an explicit field because `description` is the NORMALIZED name,
   * from which the container has already been removed — re-reading it out of the
   * text would always find nothing and silently stop comparing containers
   * altogether. Normalization extracts it to metadata; this is where it lands.
   */
  container?: string;
  /**
   * Physical product form ("gum", "roll"), when known. Explicit for the same
   * reason as `container` — normalization removes it from the description, so
   * it can only be compared if it is carried.
   */
  form?: string;
  /** Multipack count, when known. Carried for the same reason as `form`. */
  multipack?: number;
  /** Alcohol by volume, when stated. 0 marks an alcohol-free product. */
  abv?: number;
  /** Rarely known — the EPOS export carries no unit. Extracted from the text when stated. */
  uom?: Uom;
  /** The EPOS "Cost" column, for the price sanity signal. */
  mainCost?: number;
}

/** One supplier product to judge against the target. */
export interface RuleCandidate {
  supplier: string;
  name: string;
  brand?: string;
  /** Alcohol by volume, when the listing states it. 0 marks alcohol-free. */
  abv?: number;
  ean?: string;
  sku?: string;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: Uom;
  exVatCasePrice?: number;
  /**
   * Product thumbnail, when the supplier publishes one.
   *
   * Carried but never judged: no rule reads it. It rides along purely so the
   * dashboard can show the buyer what they are about to order, which is a
   * different question from whether the product matches.
   */
  imageUrl?: string;
  /** Container form factor, when known. See `RuleTarget.container`. */
  container?: string;
  /** Physical product form ("gum", "roll"), when known. */
  form?: string;
  /**
   * Multipack count, when known. Explicit for the same reason as `container`
   * and `form`: normalization removes it from the description, so it can only
   * be compared if it is carried.
   */
  multipack?: number;
  /**
   * An admin confirmed THIS product for THIS description.
   *
   * Set by the pipeline when a retrieved candidate matches a standing override
   * on both supplier and SKU. It exists because every stage downstream —
   * selection, reconciliation, supplier choice — is built to judge products
   * nobody has verified, and a human's answer must not be re-litigated by
   * machinery that cannot tell it apart from a guess.
   *
   * Carried rather than looked up so the rules stay pure: `selectFinal` and
   * `reconcileProduct` remain functions of their arguments, with no database
   * underneath them.
   */
  adminConfirmed?: boolean;
}

// ---- Rule outcomes --------------------------------------------------------

export type RuleStatus = 'pass' | 'fail' | 'unknown';

export type RuleId =
  | 'packMatch'
  | 'unitSizeMatch'
  | 'unitMatch'
  | 'caseMatch'
  | 'multipackMatch'
  | 'containerMatch'
  | 'formMatch'
  | 'alcoholMatch'
  | 'variantMatch';

export interface RuleOutcome {
  id: RuleId;
  label: string;
  status: RuleStatus;
  /**
   * A failed critical rule caps confidence below the accept threshold no matter
   * how strong the SBERT score is. Non-critical rules only corroborate.
   */
  critical: boolean;
  /** Why, in the terms the rule actually compared. */
  detail: string;
}

export type Decision = 'PASS' | 'REVIEW' | 'REJECT';

export interface RuleEvaluation {
  /** Compact view: only rules that could be evaluated appear. */
  packMatch?: boolean;
  unitSizeMatch?: boolean;
  unitMatch?: boolean;
  alcoholMatch?: boolean;
  caseMatch?: boolean;
  multipackMatch?: boolean;
  containerMatch?: boolean;
  formMatch?: boolean;
  variantMatch?: boolean;
}

export interface CandidateJudgement {
  candidateIndex: number;
  candidate: string;
  supplier: string;
  sbertSimilarity: number;
  ruleEvaluation: RuleEvaluation;
  /** Full tri-state detail for auditing, including the unknowns. */
  rules: RuleOutcome[];
  finalConfidence: number;
  decision: Decision;
  reason: string;
  /** Signal values behind `finalConfidence`. */
  breakdown: {
    sbertSimilarity: number;
    brandScore: number;
    priceScore: number;
    corroboration: number;
    base: number;
    band: 'verified' | 'unverified' | 'failed';
    criticalFailures: RuleId[];
    boosters: string[];
  };
}

// ---- Structured attribute extraction --------------------------------------

/**
 * Container form factors. Product-agnostic packaging words plus the abbreviations
 * EPOS exports use ("BTL", "CN"). This is not a flavour list: it describes the
 * physical package, and a bottle is never a bag regardless of what is inside.
 */
const CONTAINER_SYNONYMS: Record<string, string> = {
  bottle: 'bottle', btl: 'bottle', bot: 'bottle',
  can: 'can', cn: 'can', cans: 'can',
  bag: 'bag', bags: 'bag',
  box: 'box', bx: 'box', boxes: 'box',
  tube: 'tube',
  tin: 'tin', tins: 'tin',
  jar: 'jar', jars: 'jar',
  carton: 'carton', ctn: 'carton',
  pouch: 'pouch',
  sachet: 'sachet', sachets: 'sachet',
  tub: 'tub', tubs: 'tub',
  pot: 'pot', pots: 'pot',
  tray: 'tray',
  keg: 'keg',
  crate: 'crate',
  punnet: 'punnet',
};

/** "6 X 1.5L", "330ML", "500 G" → the measure a text states, normalized. */
const MEASURE_RE = /(\d+(?:\.\d+)?)\s*(ml|cl|ltr|lt|l|kg|gr|g)\b/gi;

/**
 * "4 Pack", "3PK", "x 3pk" → 4 / 3 / 3.
 *
 * A multipack count is a structured quantity, so an unstated one means one: a
 * line that does not ask for a 4-pack wants the single. That asymmetry is what
 * separates "Smarties Hexatube" from "Smarties Hexatube 4 Pack" — the exact case
 * SBERT could not call.
 */
const MULTIPACK_RE = /(?:^|[^a-z0-9])(?:x\s*)?(\d+)\s*(?:pack|pk)\b/gi;

function normalizeUom(raw: string): { uom: Uom; scale: number } {
  const u = raw.toLowerCase();
  if (u === 'kg') return { uom: 'kg', scale: 1 };
  if (u === 'g' || u === 'gr') return { uom: 'g', scale: 1 };
  if (u === 'ml') return { uom: 'ml', scale: 1 };
  if (u === 'cl') return { uom: 'ml', scale: 10 }; // cl is not a Uom — fold to ml
  return { uom: 'l', scale: 1 }; // l / lt / ltr
}

/** The unit of measure a free-text description states, if any. */
export function uomFromText(text: string): Uom | undefined {
  MEASURE_RE.lastIndex = 0;
  const matches = [...text.matchAll(MEASURE_RE)];
  const last = matches[matches.length - 1];
  return last ? normalizeUom(last[2]!).uom : undefined;
}

/**
 * The multipack count a name states, or undefined when it states none.
 *
 * `unitsPerCase` is passed so a name that merely restates its own case ("Coke
 * 24 Pack" on a 24-per-case product) is not read as a multipack. Without that
 * guard every supplier name carrying its case size would fail the rule.
 */
export function multipackCount(name: string, unitsPerCase?: number): number | undefined {
  MULTIPACK_RE.lastIndex = 0;
  const counts = [...name.matchAll(MULTIPACK_RE)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 1)
    .filter((n) => n !== unitsPerCase);
  if (counts.length === 0) return undefined;
  return Math.min(...counts);
}

/** The container form factor a name states, if exactly one is identifiable. */
export function containerOf(text: string): string | undefined {
  const found = new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .map((token) => CONTAINER_SYNONYMS[token])
      .filter((value): value is string => Boolean(value)),
  );
  // Two different containers in one name is not a usable signal.
  return found.size === 1 ? [...found][0] : undefined;
}

// ---- Variant specificity (the base-product-wins rule) ---------------------

/**
 * Commercial rule: an order line that does not ASK for a variant wants the base
 * product.
 *
 *   Excel "KINDER BUENO"  →  Kinder Bueno        wins
 *                            Kinder Bueno White  is not what was ordered
 *                            Kinder Bueno Dark   is not what was ordered
 *
 *   Excel "KINDER BUENO WHITE"  →  Kinder Bueno White  wins
 *                                  Kinder Bueno        is less specific than asked
 *
 * Decided on TOKENS, not on a vocabulary. There is no list of variant words
 * anywhere in this file — "White", "Zero" and "Cherry" are never named. What is
 * measured is purely structural: identity tokens the candidate carries that the
 * Excel line never asked for (`extra`), and tokens the Excel line asked for that
 * the candidate lacks (`missing`). That keeps the earlier constraint intact —
 * no product-specific words in the rule engine — while still deciding the case
 * deterministically.
 *
 * The rule is COMPARATIVE and self-calibrating: extra tokens are only damning
 * when a cleaner sibling actually exists. A supplier whose every listing is
 * verbose is not punished for its house style, because it is only ever compared
 * against its own listings.
 */

/** Specificity tiers, best first. A candidate is judged against the best available. */
export const enum VariantTier {
  /** Same identity tokens as the order line — the base product it asked for. */
  Exact = 0,
  /** Covers the order line, plus identity tokens it never asked for. */
  Extra = 1,
  /** Missing something the order line explicitly asked for. */
  Incomplete = 2,
}

export interface VariantSpecificity {
  tier: VariantTier;
  /** Requested identity tokens the candidate does not carry. */
  missing: string[];
  /** Identity tokens the candidate carries that were never requested. */
  extra: string[];
  /**
   * Extra tokens that are FORMULATION variants (zero, white, dark).
   *
   * Decisive on their own: the order line did not ask for this version, and no
   * amount of context makes "Kinder Bueno White" into "Kinder Bueno".
   */
  extraVariants: string[];
  /**
   * Extra tokens that are PRODUCT DESCRIPTORS (chocolate, hazelnut, cola).
   *
   * Ambiguous on their own — they may describe the same product more fully
   * ("Nutella & Go Hazelnut & Chocolate Spread") or distinguish a different one
   * ("Coca Cola Cherry"). Resolved comparatively: only damning when the same
   * supplier also lists something plainer.
   *
   * Splitting these two apart is what makes the comparative rule safe. It was
   * unsound when variants and descriptors were one undifferentiated bag.
   */
  extraDescriptors: string[];
}

/**
 * Spelling variance that is not a product difference.
 *
 * Retailer and supplier write the same name differently, and every one of these
 * would otherwise read as a variant token:
 *
 *   "M&M'S CRISPY"  vs "M&ms Crispy"     possessive + ampersand + plural
 *   "WRIGLEY'S EXTRA" vs "Wrigleys Extra"  possessive
 *
 * An ampersand with no surrounding space joins a word ("M&M" → "mm"); one with
 * spaces is a separator and is already dropped as a stop word ("Nutella & Go").
 */
function normalizeIdentityText(text: string): string {
  return text
    .toLowerCase()
    // Supplier feeds carry HTML-encoded punctuation ("M&M&apos;s Crispy",
    // "Wrigley&apos;s Extra"). Decoding FIRST matters: the ampersand rule below
    // would otherwise fuse the entity into the word and invent "wrigleyapo".
    .replace(/&apos;|&#0*39;|&rsquo;/g, "'")
    .replace(/&quot;|&#0*34;/g, '"')
    .replace(/&amp;|&#0*38;/g, '&')
    .replace(/['’]s\b/g, '') // possessive
    .replace(/['’"]/g, '')
    .replace(/([a-z0-9])&([a-z0-9])/g, '$1$2'); // "m&m" → "mm"
}

/**
 * Generic packaging and count nouns. Product-agnostic in the same way the
 * existing stop list is — "10 Pieces" describes how a pack is counted, not what
 * the product is. Container words are excluded here too because containers have
 * their OWN rule and their own failure code; counting them twice turns a
 * container question into a phantom variant.
 */
const NON_IDENTITY_TOKENS = new Set([
  'piece', 'pcs', 'pc', 'count', 'ct', 'unit', 'item', 'size', 'assorted', 'asstd',
  ...Object.keys(CONTAINER_SYNONYMS),
  ...Object.values(CONTAINER_SYNONYMS),
]);

/** Crude singular form, so "mms"/"mm" and "sweets"/"sweet" agree. */
function singular(token: string): string {
  return token.length >= 3 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
}

/**
 * Identity-bearing tokens, with brand and spelling noise removed.
 *
 * `contentTokens` already drops stop words ("std", "standard", "case", "pack")
 * and measure tokens. Brand comes off on top of that because a supplier
 * prefixing its manufacturer ("Nestle Smarties Hexatube") is house style, not a
 * variant — the exact thing `brandAgreement` exists to treat as neutral.
 *
 * `brands` takes SEVERAL brand strings because suppliers disagree about where
 * the manufacturer lives: Musgrave states it in a `brand` field, O'Reilly states
 * none at all and simply puts it in the product title. Pooling the brands known
 * for a line means "Nestle" is stripped from the O'Reilly title too, instead of
 * being read as an unrequested variant.
 *
 * Single-character tokens are dropped — they are punctuation debris, never
 * product identity.
 */
export function identityTokens(
  text: string,
  ...brands: (string | undefined)[]
): Set<string> {
  return identityTokensFor(text, undefined, brands);
}

/**
 * Identity tokens for text from a known supplier, so that supplier's own
 * catalogue decoration is stripped.
 *
 * This is the single point BOTH the rule engine and reconciliation compare
 * through, which is why product normalization is applied here: wiring it in once
 * means the two stages cannot end up normalizing differently.
 */
export function identityTokensFor(
  text: string,
  supplier: string | undefined,
  brands: readonly (string | undefined)[] = [],
  /**
   * Tokens that must NEVER be stripped as brand, because the retailer wrote
   * them. Brands are pooled across a line, so one supplier's brand field can
   * contain another product's variant — real data has "COKE ZERO" and
   * "Diet Coke" as brands alongside plain "Coca Cola". Without this guard,
   * pooling erased "zero" from BOTH sides of "COCA COLA ZERO", and plain Coke
   * and Diet Coke both scored as exact matches for it.
   *
   * A word the retailer used is identity they asked for. It can never be noise.
   */
  protectedTokens: ReadonlySet<string> = new Set(),
): Set<string> {
  // Configuration-driven: expands retail abbreviations, canonicalises synonyms,
  // and removes retail noise, containers and supplier decoration. No product
  // name appears in this file — see config/normalization.json.
  const normalized = normalizedIdentity(text, supplier ? { supplier } : {});

  const brandTokens = [
    ...new Set(
      brands
        .filter((brand): brand is string => Boolean(brand))
        .flatMap((brand) =>
          contentTokens(normalizeIdentityText(normalizedIdentity(brand))),
        )
        .map(singular),
    ),
  ].filter((token) => !protectedTokens.has(token));

  /**
   * True for a brand token, including the truncations suppliers use in listing
   * titles — O'Reilly writes "Wri Extra - Cool Breeze" for Wrigley's Extra.
   * Requiring 3 characters keeps this from matching on an initial.
   */
  const isBrand = (token: string) =>
    brandTokens.some(
      (brand) => brand === token || (token.length >= 3 && brand.startsWith(token)),
    );

  return new Set(
    contentTokens(normalizeIdentityText(normalized))
      .map(singular)
      .filter(
        (token) => token.length > 1 && !NON_IDENTITY_TOKENS.has(token) && !isBrand(token),
      ),
  );
}

/**
 * How a candidate's identity tokens relate to the order line's.
 *
 * `knownBrands` are additional brand strings observed elsewhere for this same
 * line — see `identityTokens`.
 */
export function specificityOf(
  target: RuleTarget,
  candidate: RuleCandidate,
  knownBrands: readonly (string | undefined)[] = [],
): VariantSpecificity {
  // The brand is stripped from BOTH sides, so naming it on one side only is
  // never read as a missing or an extra token.
  //
  // Only the CANDIDATE side is normalized against its supplier's decoration
  // list — "std" is O'Reilly catalogue style, not something a retailer wrote.
  // The retailer side gets the retailer normalization (abbreviations, noise).
  const brands = [candidate.brand, ...knownBrands];

  // Everything the retailer actually wrote, with NO brand stripping. These
  // tokens are protected on both sides: a pooled brand field must never be able
  // to delete a word the order line asked for.
  const protectedTokens = identityTokensFor(target.description, undefined);

  const wanted = identityTokensFor(target.description, undefined, brands, protectedTokens);
  const have = identityTokensFor(candidate.name, candidate.supplier, brands, protectedTokens);

  const missing = [...wanted].filter((token) => !have.has(token)).sort();
  const extra = [...have].filter((token) => !wanted.has(token)).sort();

  // One token, one category — so this split is a property of the tokens, not a
  // judgement about this particular product.
  const extraVariants = extra.filter((token) => categoryOf(token) === 'variant');
  const extraDescriptors = extra.filter((token) => categoryOf(token) !== 'variant');

  const tier =
    missing.length > 0
      ? VariantTier.Incomplete
      : extra.length > 0
        ? VariantTier.Extra
        : VariantTier.Exact;

  return { tier, missing, extra, extraVariants, extraDescriptors };
}

interface VariantVerdict {
  status: RuleStatus;
  detail: string;
  /** True when this candidate's identity tokens match the order line exactly. */
  exact: boolean;
}

/**
 * Judge every candidate's specificity against its SAME-SUPPLIER siblings.
 *
 * Per supplier, not globally, because naming verbosity is a house style:
 * O'Reilly writes "Std - Snickers Bar" where Musgrave writes "Snickers". Judged
 * across suppliers, the wordier supplier would lose every line and its prices
 * would vanish from the comparison — which is the opposite of the point.
 */
function variantVerdicts(
  target: RuleTarget,
  ranked: readonly RankedInput[],
): Map<number, VariantVerdict> {
  const bestTierBySupplier = new Map<string, VariantTier>();
  const specificities = new Map<number, VariantSpecificity>();

  // Every brand any supplier stated for this line. A supplier that puts the
  // manufacturer in the title rather than a brand field still gets it stripped.
  const knownBrands = [...new Set(ranked.map((entry) => entry.candidate.brand).filter(Boolean))];

  for (const entry of ranked) {
    const specificity = specificityOf(target, entry.candidate, knownBrands);
    specificities.set(entry.candidateIndex, specificity);

    const supplier = entry.candidate.supplier;
    const best = bestTierBySupplier.get(supplier);
    if (best === undefined || specificity.tier < best) {
      bestTierBySupplier.set(supplier, specificity.tier);
    }
  }

  const verdicts = new Map<number, VariantVerdict>();

  for (const entry of ranked) {
    const specificity = specificities.get(entry.candidateIndex)!;
    const best = bestTierBySupplier.get(entry.candidate.supplier)!;
    const exact = specificity.tier === VariantTier.Exact;

    // An unrequested FORMULATION is decisive on its own — no sibling context can
    // make it acceptable. This is checked before everything else so a supplier
    // that stocks only "Kinder Bueno White" can never have it accepted as plain
    // Kinder Bueno.
    if (specificity.extraVariants.length > 0) {
      verdicts.set(entry.candidateIndex, {
        status: 'fail',
        detail: `unrequested variant (${specificity.extraVariants.join(', ')}) — the order line did not ask for it`,
        exact: false,
      });
      continue;
    }

    // An exact token match needs no comparison — it IS the order line.
    if (exact) {
      verdicts.set(entry.candidateIndex, {
        status: 'pass',
        detail: 'identity tokens match the order line exactly',
        exact,
      });
      continue;
    }

    // Otherwise only this supplier's own listings can condemn it. With a single
    // listing there is nothing to compare against, so extras are tolerated.
    const hasSiblings = ranked.some(
      (other) =>
        other.candidate.supplier === entry.candidate.supplier &&
        other.candidateIndex !== entry.candidateIndex,
    );

    if (!hasSiblings) {
      verdicts.set(entry.candidateIndex, {
        status: 'unknown',
        detail: 'only listing from this supplier — nothing to compare specificity against',
        exact,
      });
      continue;
    }

    if (specificity.tier === best) {
      verdicts.set(entry.candidateIndex, {
        status: 'pass',
        detail: exact
          ? 'identity tokens match the order line exactly'
          : specificity.tier === VariantTier.Extra
            ? `closest listing this supplier has (extra: ${specificity.extra.join(', ')})`
            : `closest listing this supplier has (missing: ${specificity.missing.join(', ')})`,
        exact,
      });
      continue;
    }

    verdicts.set(entry.candidateIndex, {
      status: 'fail',
      detail:
        specificity.tier === VariantTier.Incomplete
          ? `does not carry requested ${specificity.missing.join(', ')} — a more specific listing exists`
          : `unrequested variant (${specificity.extra.join(', ')}) — the order line did not ask for it`,
      exact,
    });
  }

  return verdicts;
}

/** Unit size converted to its family's base unit (each / ml / g). */
function baseUnitSize(unitSize: number, uom: Uom): { family: string; quantity: number } {
  const { family, quantity } = caseBaseQuantity({
    unitsPerCase: 1,
    unitSize,
    uom,
    isCatchWeight: false,
  });
  return { family, quantity };
}

// ---- The rules ------------------------------------------------------------

const UNKNOWN_PACK = 'Pack not stated on both sides — cannot verify.';

/**
 * Evaluate every structured rule for one candidate.
 *
 * Exported separately from the scoring so the rules can be tested, and read, on
 * their own terms.
 */
export function evaluateRules(
  target: RuleTarget,
  candidate: RuleCandidate,
  /**
   * The comparative variant verdict. Computed across the candidate list by
   * `judgeCandidates`, because "is there a cleaner listing?" cannot be answered
   * from one candidate alone.
   */
  variant?: { status: RuleStatus; detail: string },
): RuleOutcome[] {
  const rules: RuleOutcome[] = [];

  const pack = comparePack(
    { ...(target.unitsPerCase !== undefined ? { unitsPerCase: target.unitsPerCase } : {}),
      ...(target.unitSize !== undefined ? { unitSize: target.unitSize } : {}) },
    candidate.unitsPerCase && candidate.unitSize
      ? { unitsPerCase: candidate.unitsPerCase, unitSize: candidate.unitSize }
      : undefined,
  );

  // --- Units per case ----------------------------------------------------
  //
  // A pack difference is a QUANTITY question, not a wrong product. With
  // `packDifference: 'warn'` the line still reaches Ready To Order with the
  // difference stated and the other sizes offered as alternatives, so the
  // retailer can see that 30 × 14 was requested and 10 × 14 is what the
  // supplier sells. Hiding the line entirely means they never learn the product
  // is available at all.
  //
  // Identity rules — variant, alcohol, form, container — are unaffected and
  // stay critical. A different size is still the same product; a different
  // variant is not.
  const packIsCritical = getMatchingConfig().packDifference === 'reject';

  rules.push({
    id: 'packMatch',
    label: 'Pack Match',
    critical: packIsCritical,
    status: !pack.known ? 'unknown' : pack.unitsPerCaseMatch ? 'pass' : 'fail',
    detail: !pack.known
      ? UNKNOWN_PACK
      : `units per case ${target.unitsPerCase} vs ${candidate.unitsPerCase}`,
  });

  // --- Unit size ---------------------------------------------------------
  // Compared in base units when both sides state a uom, so "1.5 L" and "1500 ml"
  // agree instead of failing on a scale difference.
  const targetUom = target.uom ?? uomFromText(target.description);
  const candidateUom = candidate.uom;

  let unitSizeStatus: RuleStatus = pack.known ? (pack.unitSizeMatch ? 'pass' : 'fail') : 'unknown';
  let unitSizeDetail = !pack.known
    ? UNKNOWN_PACK
    : `unit size ${target.unitSize} vs ${candidate.unitSize}` +
      (pack.unitSizeTolerance ? ` (±${pack.unitSizeTolerance.toFixed(2)})` : '');

  if (
    pack.known &&
    !pack.unitSizeMatch &&
    targetUom &&
    candidateUom &&
    target.unitSize !== undefined &&
    candidate.unitSize !== undefined
  ) {
    const left = baseUnitSize(target.unitSize, targetUom);
    const right = baseUnitSize(candidate.unitSize, candidateUom);
    if (left.family === right.family) {
      const tolerance = Math.max(PACK_ABS_TOLERANCE, left.quantity * PACK_REL_TOLERANCE);
      if (Math.abs(left.quantity - right.quantity) <= tolerance) {
        unitSizeStatus = 'pass';
        unitSizeDetail =
          `unit size ${target.unitSize}${targetUom} vs ${candidate.unitSize}${candidateUom}` +
          ` — equal at ${left.quantity} base units`;
      }
    }
  }

  // A unit-size difference when the CASE CONFIGURATION is identical is a
  // stocking question, not a wrong product: "48 × 48g requested, 48 × 40g
  // available" is the same product in a smaller unit, and the retailer may well
  // take it. Within the configured band it stops being critical so the line can
  // pass with a warning instead of vanishing into Needs Attention.
  //
  // A differing units-per-case is untouched by this and stays critical — that
  // is the 24 × 38 versus 4 × 34 case that proved SBERT alone was insufficient.
  // A size difference is the same quantity question as a pack difference.
  let unitSizeCritical = packIsCritical;
  if (
    unitSizeStatus === 'fail' &&
    pack.unitsPerCaseMatch &&
    target.unitSize !== undefined &&
    candidate.unitSize !== undefined &&
    target.unitSize > 0
  ) {
    const drift = Math.abs(candidate.unitSize - target.unitSize) / target.unitSize;
    if (drift <= getMatchingConfig().unitSize.nearMatchPct) {
      unitSizeCritical = false;
      unitSizeDetail =
        `unit size differs but the case is identical — requested ${target.unitSize}` +
        `${targetUom ?? ''}, available ${candidate.unitSize}${candidateUom ?? ''}`;
    }
  }

  rules.push({
    id: 'unitSizeMatch',
    label: 'Unit Size Match',
    critical: unitSizeCritical,
    status: unitSizeStatus,
    detail: unitSizeDetail,
  });

  // --- Unit of measure ---------------------------------------------------
  // Compared by FAMILY (count / volume / mass): g vs kg is the same thing at a
  // different scale, while g vs ml is a different physical quantity.
  rules.push(
    ((): RuleOutcome => {
      if (!targetUom || !candidateUom) {
        return {
          id: 'unitMatch',
          label: 'Unit Match',
          critical: true,
          status: 'unknown',
          detail: !targetUom
            ? 'EPOS line states no unit of measure — nothing to compare.'
            : 'Supplier card states no unit of measure.',
        };
      }
      const left = baseUnitSize(1, targetUom);
      const right = baseUnitSize(1, candidateUom);
      return {
        id: 'unitMatch',
        label: 'Unit Match',
        critical: true,
        status: left.family === right.family ? 'pass' : 'fail',
        detail: `${targetUom} (${left.family}) vs ${candidateUom} (${right.family})`,
      };
    })(),
  );

  // --- Total case content ------------------------------------------------
  // Corroborating rather than critical: it is derived from the two rules above
  // and earns its place by catching scale errors they would miss.
  rules.push(
    ((): RuleOutcome => {
      if (!pack.known || target.unitsPerCase === undefined || candidate.unitsPerCase === undefined) {
        return {
          id: 'caseMatch',
          label: 'Case Match',
          critical: false,
          status: 'unknown',
          detail: UNKNOWN_PACK,
        };
      }
      // Without a stated EPOS unit, assume the candidate's — the comparison is
      // then purely numeric, which is exactly what the EPOS file supports.
      const uom = targetUom ?? candidateUom ?? 'each';
      const left = baseUnitSize(target.unitSize!, uom).quantity * target.unitsPerCase;
      const right =
        baseUnitSize(candidate.unitSize!, candidateUom ?? uom).quantity * candidate.unitsPerCase;
      const tolerance = Math.max(PACK_ABS_TOLERANCE, left * PACK_REL_TOLERANCE);
      return {
        id: 'caseMatch',
        label: 'Case Match',
        critical: false,
        status: Math.abs(left - right) <= tolerance ? 'pass' : 'fail',
        detail: `case content ${left} vs ${right} base units`,
      };
    })(),
  );

  // --- Multipack ---------------------------------------------------------
  rules.push(
    ((): RuleOutcome => {
      // Explicit field first. Normalization removes "10 PACK" from the
      // description, so parsing it back out would always find nothing and the
      // rule would silently compare every multipack against a single.
      // The "is this just restating the case?" guard has to be SYMMETRIC. Each
      // side used to apply it against its OWN units-per-case, so when the two
      // disagreed about case size the comparison broke:
      //
      //   retailer "10 PK", case 30 → 10 kept (10 ≠ 30)
      //   supplier "10 Pack", case 10 → suppressed (10 = 10) → read as 1
      //   → a false "multipack 10 vs 1" on the SAME 10-pack.
      //
      // Suppressing against either side's case size makes both read the same.
      const cases = [target.unitsPerCase, candidate.unitsPerCase].filter(
        (value): value is number => value !== undefined,
      );
      const restatesCase = (count: number | undefined) =>
        count !== undefined && cases.includes(count);

      let targetCount =
        target.multipack ?? multipackCount(target.description, target.unitsPerCase);
      let candidateCount =
        candidate.multipack ?? multipackCount(candidate.name, candidate.unitsPerCase);

      if (restatesCase(targetCount)) targetCount = undefined;
      if (restatesCase(candidateCount)) candidateCount = undefined;
      if (targetCount === undefined && candidateCount === undefined) {
        return {
          id: 'multipackMatch',
          label: 'Multipack Match',
          critical: true,
          status: 'pass',
          detail: 'neither side states a multipack',
        };
      }
      // Unstated means single. A 4-pack is a different commercial product from
      // the single, so a one-sided count is a genuine mismatch, not a descriptor.
      const left = targetCount ?? 1;
      const right = candidateCount ?? 1;
      return {
        id: 'multipackMatch',
        label: 'Multipack Match',
        critical: true,
        status: left === right ? 'pass' : 'fail',
        detail: `multipack ${left} vs ${right}`,
      };
    })(),
  );

  // --- Container ---------------------------------------------------------
  rules.push(
    ((): RuleOutcome => {
      // Explicit field first: `target.description` is normalized text with the
      // container already stripped, so reading it back would always be empty.
      const left = target.container ?? containerOf(target.description);
      const right = candidate.container ?? containerOf(candidate.name);
      if (!left || !right) {
        return {
          id: 'containerMatch',
          label: 'Container Match',
          critical: false,
          status: 'unknown',
          detail: 'container not stated on both sides',
        };
      }
      return {
        id: 'containerMatch',
        label: 'Container Match',
        critical: false,
        status: left === right ? 'pass' : 'fail',
        detail: `${left} vs ${right}`,
      };
    })(),
  );

  // --- Product form --------------------------------------------------------
  // Compared like a container: only when BOTH sides state one, and a gum is
  // never a bar. Unknown on either side is not a mismatch.
  rules.push(
    ((): RuleOutcome => {
      const left = target.form;
      const right = candidate.form;
      if (!left || !right) {
        return {
          id: 'formMatch',
          label: 'Form Match',
          critical: false,
          status: 'unknown',
          detail: 'product form not stated on both sides',
        };
      }
      return {
        id: 'formMatch',
        label: 'Form Match',
        critical: true,
        status: left === right ? 'pass' : 'fail',
        detail: `${left} vs ${right}`,
      };
    })(),
  );

  // --- Alcohol by volume ---------------------------------------------------
  //
  // Deliberately ASYMMETRIC, and the only rule that is.
  //
  // An alcohol-free order must never be filled with the full-strength product,
  // so when the retailer asks for 0.0% a candidate that does not also state 0.0%
  // FAILS — even though its ABV is merely unknown rather than contradicting.
  // That is safe because alcohol-free is always marked on the product: its
  // absence means full strength. Treating it as `unknown` here would let
  // "Guinness Draught Stout" satisfy an order for "Guinness Draught 0.0%".
  //
  // The reverse is not symmetric: a full-strength order does not fail merely
  // because a candidate is silent about ABV.
  rules.push(
    ((): RuleOutcome => {
      if (target.abv !== 0) {
        return {
          id: 'alcoholMatch',
          label: 'Alcohol Match',
          critical: false,
          status: 'unknown',
          detail: 'order line states no alcohol-free requirement',
        };
      }
      const matches = candidate.abv === 0;
      return {
        id: 'alcoholMatch',
        label: 'Alcohol Match',
        critical: true,
        status: matches ? 'pass' : 'fail',
        detail: matches
          ? 'both alcohol-free (0.0%)'
          : `order line is alcohol-free (0.0%); this product does not state 0.0%${
              candidate.abv !== undefined ? ` (${candidate.abv}%)` : ''
            }`,
      };
    })(),
  );

  // --- Requested variant --------------------------------------------------
  // Critical: buying "Kinder Bueno White" against an order for "Kinder Bueno"
  // is buying the wrong product, however similar the two names read.
  rules.push({
    id: 'variantMatch',
    label: 'Variant Match',
    critical: true,
    status: variant?.status ?? 'unknown',
    detail: variant?.detail ?? 'no sibling listings to compare specificity against',
  });

  return rules;
}

// ---- Confidence -----------------------------------------------------------

/**
 * Signal weights. SBERT dominates because, inside the gates, "is this the same
 * product?" is the question it is genuinely good at. Sum to 1.
 */
const W_SBERT = 0.55;
const W_BRAND = 0.1;
const W_PRICE = 0.15;
const W_CORROBORATION = 0.2;

/**
 * Confidence bands, mirroring `matchConfidence`'s gated/ungated architecture.
 *
 *   verified   — every critical rule passed AND the pack was actually checked
 *   unverified — nothing failed, but the pack could not be verified
 *   failed     — a critical rule failed; the ceiling here is below the review
 *                floor, so no SBERT score can rescue it
 */
const BANDS = {
  verified: { floor: 0.8, range: 0.19 },
  unverified: { floor: 0.55, range: 0.25 },
  failed: { floor: 0.1, range: 0.45 },
} as const;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Fraction of the non-critical rules that corroborated, neutral when none ran. */
function corroborationScore(rules: readonly RuleOutcome[]): number {
  const judged = rules.filter((r) => r.status !== 'unknown');
  if (judged.length === 0) return 0.5;
  return judged.filter((r) => r.status === 'pass').length / judged.length;
}

function compactEvaluation(rules: readonly RuleOutcome[]): RuleEvaluation {
  const evaluation: RuleEvaluation = {};
  for (const rule of rules) {
    if (rule.status === 'unknown') continue;
    evaluation[rule.id] = rule.status === 'pass';
  }
  return evaluation;
}

const DECISION_BY_BUCKET = {
  matched: 'PASS',
  'needs-review': 'REVIEW',
  unmatched: 'REJECT',
} as const;

export interface JudgeOptions {
  /** Accept threshold. Defaults to the project-wide 0.90. */
  minConfidence?: number;
  /** Labels for boosters applied from outside, e.g. cross-supplier EAN agreement. */
  boosters?: string[];
  /** Floor a booster imposes. */
  boostFloor?: number;
  /** Comparative variant verdict, computed across the candidate list. */
  variant?: { status: RuleStatus; detail: string; exact: boolean };
}

/**
 * Judge one SBERT-ranked candidate. Pure and deterministic — same inputs, same
 * verdict, every time.
 */
export function judgeCandidate(
  target: RuleTarget,
  candidate: RuleCandidate,
  sbertSimilarity: number,
  candidateIndex: number,
  opts: JudgeOptions = {},
): CandidateJudgement {
  const rules = evaluateRules(target, candidate, opts.variant);

  const criticalFailures = rules
    .filter((r) => r.critical && r.status === 'fail')
    .map((r) => r.id);

  // "Verified" means the pack was CHECKED, not that it agreed.
  //
  // A pack that was compared and differs is known information — the retailer
  // sees "requested 30 × 14, supplier sells 10 × 14" and decides. A pack that
  // could not be checked at all is genuinely unverified and stays capped below
  // the accept threshold. Conflating the two kept every size difference out of
  // Ready To Order even after pack stopped being a critical rule.
  const packVerified = rules.some(
    (r) => r.id === 'packMatch' && r.status !== 'unknown',
  );

  const band: 'verified' | 'unverified' | 'failed' =
    criticalFailures.length > 0 ? 'failed' : packVerified ? 'verified' : 'unverified';

  const brandScore = brandAgreement(target.description, candidate.brand);
  const priceScore = priceAgreement(target.mainCost, candidate.exVatCasePrice);
  const corroboration = corroborationScore(rules.filter((r) => !r.critical));

  // SBERT similarity is a cosine in [-1, 1]; clamp before weighting.
  const similarity = Math.min(1, Math.max(0, sbertSimilarity));

  const base =
    W_SBERT * similarity +
    W_BRAND * brandScore +
    W_PRICE * priceScore +
    W_CORROBORATION * corroboration;

  const { floor, range } = BANDS[band];
  let confidence = floor + range * base;

  // A booster can lift an unverified match; it can NEVER rescue a failed one.
  //
  // `matchConfidence.applyConfidenceBooster` deliberately lets cross-supplier EAN
  // agreement override its gates, but it is applied there to the best candidate
  // PER SUPPLIER after ranking. Applied across a whole candidate list it means
  // something weaker: that two suppliers agree with EACH OTHER about a product's
  // identity. That is no evidence at all about whether the product is the one the
  // Excel line asked for — two suppliers can both stock the same 4 × 34 g pack
  // when the order wants 24 × 38 g. Structured contradiction outranks it.
  // Copied — this list is appended to below and must not mutate the caller's.
  const boosters = band === 'failed' ? [] : [...(opts.boosters ?? [])];
  if (boosters.length > 0 && opts.boostFloor !== undefined) {
    confidence = Math.max(confidence, opts.boostFloor);
  }

  // An exact identity-token match with every structured rule satisfied is as
  // certain as this pipeline gets: the order line's words, the pack, the unit
  // and the multipack all agree, and no sibling listing is a closer read. Lift
  // it to the ceiling so a terse supplier name cannot leave a decided line
  // sitting under the accept threshold on SBERT wording alone.
  // Also applies in the `unverified` band. An exact identity match with nothing
  // contradicting it is strong evidence in its own right: "Wrigleys Extra
  // Spearmint" against "Wrigleys Extra Spearmint" was landing in REVIEW purely
  // because the supplier published no pack size, which says nothing about
  // whether it is the right product.
  if (band !== 'failed' && opts.variant?.exact && criticalFailures.length === 0) {
    confidence = Math.max(confidence, CONFIDENCE_CEILING);
    boosters.push('exact-token-match');
  }

  const decision =
    DECISION_BY_BUCKET[bucketFor(confidence, opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE)];

  const failed = rules.filter((r) => r.critical && r.status === 'fail');
  const reason =
    failed.length > 0
      ? `Rejected on ${failed.map((r) => r.label).join(', ')} — ${failed[0]!.detail}.`
      : band === 'unverified'
        ? 'Nothing contradicts this match, but the pack could not be verified on both sides.'
        : 'All structured attributes agree.';

  return {
    candidateIndex,
    candidate: candidate.name,
    supplier: candidate.supplier,
    sbertSimilarity: round3(sbertSimilarity),
    ruleEvaluation: compactEvaluation(rules),
    rules,
    finalConfidence: round3(confidence),
    decision,
    reason,
    breakdown: {
      sbertSimilarity: round3(similarity),
      brandScore: round3(brandScore),
      priceScore: round3(priceScore),
      corroboration: round3(corroboration),
      base: round3(base),
      band,
      criticalFailures,
      boosters,
    },
  };
}

// ---- Product-level pass ---------------------------------------------------

export interface RankedInput {
  candidateIndex: number;
  candidate: RuleCandidate;
  similarity: number;
}

/**
 * Judge every SBERT-ranked candidate for one product.
 *
 * The only cross-candidate rule lives here: when two DIFFERENT suppliers report
 * the same GTIN-14 for this line, that is independent identity evidence and it
 * lifts the floor — the same reasoning, and the same floor, as
 * `applyConfidenceBooster('cross-supplier-ean')` in `matchConfidence`.
 */
export function judgeCandidates(
  target: RuleTarget,
  ranked: readonly RankedInput[],
  opts: JudgeOptions = {},
): CandidateJudgement[] {
  // Comparative pass first — "is a cleaner listing available?" needs the list.
  const variants = variantVerdicts(target, ranked);

  // GTIN → the distinct suppliers reporting it.
  const suppliersByGtin = new Map<string, Set<string>>();
  for (const entry of ranked) {
    const gtin = entry.candidate.ean
      ? cardGtin({ eanText: entry.candidate.ean } as SearchCard)
      : undefined;
    if (!gtin) continue;
    const set = suppliersByGtin.get(gtin) ?? new Set<string>();
    set.add(entry.candidate.supplier);
    suppliersByGtin.set(gtin, set);
  }

  return ranked.map((entry) => {
    const gtin = entry.candidate.ean
      ? cardGtin({ eanText: entry.candidate.ean } as SearchCard)
      : undefined;
    const agreed = gtin ? (suppliersByGtin.get(gtin)?.size ?? 0) >= 2 : false;

    const variant = variants.get(entry.candidateIndex);

    return judgeCandidate(target, entry.candidate, entry.similarity, entry.candidateIndex, {
      ...opts,
      ...(variant ? { variant } : {}),
      ...(agreed
        ? { boosters: ['cross-supplier-ean'], boostFloor: CROSS_SUPPLIER_EAN_FLOOR }
        : {}),
    });
  });
}

// ---- Final selection ------------------------------------------------------

/**
 * Turn a judged candidate list into the ONE product per supplier that will be
 * ordered, or nothing at all.
 *
 * Why one per supplier, not one overall
 * -------------------------------------
 * Two PASSes from two different suppliers is the normal, desired outcome: it is
 * the same product available from both, and choosing between them is a PRICE
 * decision that belongs to the allocation engine, which already routes on
 * ex-VAT-per-base-unit, per-supplier thresholds and min-order repair. Collapsing
 * to a single global winner here would pick a supplier before any price was
 * compared, and quietly delete the cross-supplier saving this whole system
 * exists to find.
 *
 * Two PASSes from the SAME supplier is the opposite — a genuine ambiguity about
 * which product the line means. That is resolved here, and if it cannot be
 * resolved the supplier is dropped rather than guessed at.
 *
 * The output is exactly what `prepareLine` consumes: at most one offer per
 * supplier for one line. The full ranked list never reaches allocation.
 */

/**
 * Gap needed between two same-supplier candidates to call a winner.
 *
 * Measured on `breakdown.base` — the weighted soft-signal total — NOT on
 * `finalConfidence`. Both candidates reaching here passed every structured rule,
 * so the structured attributes are by definition identical and the soft signals
 * are the only thing discriminating. `base` is also the right SCALE: it spans a
 * full 0..1, matching `matchConfidence`'s CLEAR_MARGIN, whereas `finalConfidence`
 * is compressed into a 0.19-wide band where SBERT can move it by at most ~0.105.
 * Testing a 0.12 gap against the banded number would flag almost every supplier
 * with two passing candidates as ambiguous.
 */
export const AMBIGUITY_MARGIN = 0.12;

export interface SelectedCandidate {
  supplier: string;
  candidateIndex: number;
  name: string;
  /** Alcohol by volume, when the listing states it. 0 marks alcohol-free. */
  abv?: number;
  /** Carried so reconciliation can strip it from both sides' identity tokens. */
  brand?: string;
  sku?: string;
  ean?: string;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: Uom;
  /** Container form factor, when known. See `RuleTarget.container`. */
  container?: string;
  /** Physical product form ("gum", "roll"), when known. */
  form?: string;
  /**
   * Multipack count, when known. Explicit for the same reason as `container`
   * and `form`: normalization removes it from the description, so it can only
   * be compared if it is carried.
   */
  multipack?: number;
  exVatCasePrice?: number;
  /** Carried through selection so the dashboard can show it. Never judged. */
  imageUrl?: string;
  finalConfidence: number;
  sbertSimilarity: number;
  /** Why this one won its supplier. */
  reason: string;
  /** An admin confirmed this product. See `RuleCandidate.adminConfirmed`. */
  adminConfirmed?: boolean;
}

export type SelectionStatus =
  | 'selected'
  | 'no-candidates'
  | 'no-pass'
  | 'not-orderable'
  | 'ambiguous';

export interface SupplierExclusion {
  supplier: string;
  reason: string;
  /** The candidates that could not be told apart. */
  candidateIndexes: number[];
  /**
   * True when every deterministic rule was applied and still could not separate
   * them. These are the ONLY cases a semantic layer (GPT) should be asked about
   * — everything else was already decided without it.
   */
  needsAiReview: boolean;
}

export interface FinalSelection {
  status: SelectionStatus;
  /**
   * At most one winner per supplier — the allocation engine's input. Empty when
   * nothing was selectable.
   */
  selected: SelectedCandidate[];
  /**
   * The strongest single selection. This is the line's product identity (name,
   * EAN, pack) — NOT a decision about who to buy from.
   */
  primary?: SelectedCandidate;
  /** Suppliers that had a PASS but were dropped, and why. */
  excluded: SupplierExclusion[];
  reason: string;
}

/**
 * A candidate is only orderable with a product code and a usable price.
 * Confidence says "this is the right product"; these say "we can place the
 * line". Same rule `orderFile.service.ts` applies before a SKU reaches a CSV.
 */
function isOrderable(candidate: RuleCandidate): boolean {
  return (
    Boolean(candidate.sku) &&
    candidate.exVatCasePrice !== undefined &&
    Number.isFinite(candidate.exVatCasePrice) &&
    candidate.exVatCasePrice > 0
  );
}

/** How many rules actually returned a verdict — more checks is more evidence. */
function evidenceCount(judgement: CandidateJudgement): number {
  return judgement.rules.filter((r) => r.status === 'pass').length;
}

/**
 * Deterministic ordering within one supplier. Every tie-break is total, so the
 * same inputs always yield the same winner regardless of array order.
 */
function compareWithinSupplier(
  a: { judgement: CandidateJudgement; candidate: RuleCandidate },
  b: { judgement: CandidateJudgement; candidate: RuleCandidate },
): number {
  if (b.judgement.finalConfidence !== a.judgement.finalConfidence) {
    return b.judgement.finalConfidence - a.judgement.finalConfidence;
  }
  const evidence = evidenceCount(b.judgement) - evidenceCount(a.judgement);
  if (evidence !== 0) return evidence;

  if (b.judgement.sbertSimilarity !== a.judgement.sbertSimilarity) {
    return b.judgement.sbertSimilarity - a.judgement.sbertSimilarity;
  }
  // Same product on every measure we have — take the cheaper listing.
  const priceA = a.candidate.exVatCasePrice ?? Number.POSITIVE_INFINITY;
  const priceB = b.candidate.exVatCasePrice ?? Number.POSITIVE_INFINITY;
  if (priceA !== priceB) return priceA - priceB;

  return a.judgement.candidateIndex - b.judgement.candidateIndex;
}

function toSelected(
  judgement: CandidateJudgement,
  candidate: RuleCandidate,
  reason: string,
): SelectedCandidate {
  return {
    supplier: candidate.supplier,
    candidateIndex: judgement.candidateIndex,
    name: candidate.name,
    ...(candidate.brand ? { brand: candidate.brand } : {}),
    ...(candidate.sku ? { sku: candidate.sku } : {}),
    ...(candidate.ean ? { ean: candidate.ean } : {}),
    ...(candidate.unitsPerCase !== undefined ? { unitsPerCase: candidate.unitsPerCase } : {}),
    ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
    ...(candidate.uom ? { uom: candidate.uom } : {}),
    ...(candidate.container ? { container: candidate.container } : {}),
    ...(candidate.form ? { form: candidate.form } : {}),
    ...(candidate.multipack !== undefined ? { multipack: candidate.multipack } : {}),
    ...(candidate.abv !== undefined ? { abv: candidate.abv } : {}),
    ...(candidate.exVatCasePrice !== undefined
      ? { exVatCasePrice: candidate.exVatCasePrice }
      : {}),
    ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
    ...(candidate.adminConfirmed ? { adminConfirmed: true } : {}),
    finalConfidence: judgement.finalConfidence,
    sbertSimilarity: judgement.sbertSimilarity,
    reason,
  };
}

/**
 * Select the final product(s) for one Excel line.
 *
 * `ranked` and `judgements` are paired on `candidateIndex`; a judgement with no
 * matching candidate is ignored rather than trusted.
 */
export function selectFinal(
  ranked: readonly RankedInput[],
  judgements: readonly CandidateJudgement[],
): FinalSelection {
  if (ranked.length === 0) {
    return {
      status: 'no-candidates',
      selected: [],
      excluded: [],
      reason: 'No supplier returned a candidate for this line.',
    };
  }

  const byIndex = new Map(ranked.map((entry) => [entry.candidateIndex, entry.candidate]));

  // An admin-confirmed candidate is admitted whatever the rules decided about
  // it. The rules answer "is this plausibly the requested product"; a human has
  // already answered it, and usually confirmed precisely the product the rules
  // could not accept — a differing pack, a reworded variant. Re-asking here
  // would discard the correction at the first gate after retrieval.
  const passes = judgements
    .filter((j) => j.decision === 'PASS' || byIndex.get(j.candidateIndex)?.adminConfirmed)
    .map((judgement) => ({ judgement, candidate: byIndex.get(judgement.candidateIndex) }))
    .filter(
      (pair): pair is { judgement: CandidateJudgement; candidate: RuleCandidate } =>
        pair.candidate !== undefined,
    );

  if (passes.length === 0) {
    return {
      status: 'no-pass',
      selected: [],
      excluded: [],
      reason: 'No candidate passed the rule engine.',
    };
  }

  const orderable = passes.filter((pair) => isOrderable(pair.candidate));
  if (orderable.length === 0) {
    return {
      status: 'not-orderable',
      selected: [],
      excluded: [],
      reason: 'Candidates passed, but none carried both a product code and a usable price.',
    };
  }

  // Group by supplier — the winner is decided inside each supplier, never across.
  const bySupplier = new Map<string, typeof orderable>();
  for (const pair of orderable) {
    const bucket = bySupplier.get(pair.candidate.supplier) ?? [];
    bucket.push(pair);
    bySupplier.set(pair.candidate.supplier, bucket);
  }

  const selected: SelectedCandidate[] = [];
  const excluded: SupplierExclusion[] = [];

  for (const [supplier, pairs] of bySupplier) {
    const sorted = [...pairs].sort(compareWithinSupplier);

    // A confirmed product wins its supplier outright. Not a tie-break — the
    // ambiguity check below exists to avoid guessing between two candidates,
    // and there is nothing to guess when a human named one of them.
    const confirmed = sorted.find((pair) => pair.candidate.adminConfirmed);
    if (confirmed) {
      selected.push(
        toSelected(
          confirmed.judgement,
          confirmed.candidate,
          `Confirmed by an admin for this description (${supplier}).`,
        ),
      );
      continue;
    }

    const winner = sorted[0]!;
    const runnerUp = sorted[1];

    if (runnerUp) {
      const gap = winner.judgement.breakdown.base - runnerUp.judgement.breakdown.base;
      const sameProduct =
        (winner.candidate.ean !== undefined &&
          winner.candidate.ean === runnerUp.candidate.ean) ||
        winner.candidate.sku === runnerUp.candidate.sku;

      // Two DIFFERENT products from one supplier, too close to tell apart. The
      // same product listed twice is not ambiguous — take the cheaper listing.
      if (!sameProduct && gap < AMBIGUITY_MARGIN) {
        excluded.push({
          supplier,
          candidateIndexes: [
            winner.judgement.candidateIndex,
            runnerUp.judgement.candidateIndex,
          ],
          needsAiReview: true,
          reason:
            `Two different products separated by only ${gap.toFixed(3)} ` +
            `("${winner.candidate.name}" vs "${runnerUp.candidate.name}") — ` +
            'every deterministic rule passed for both, so only a semantic layer can separate them.',
        });
        continue;
      }
    }

    selected.push(
      toSelected(
        winner.judgement,
        winner.candidate,
        runnerUp
          ? `Best of ${pairs.length} passing candidates from ${supplier}.`
          : `Only passing candidate from ${supplier}.`,
      ),
    );
  }

  if (selected.length === 0) {
    return {
      status: 'ambiguous',
      selected: [],
      excluded,
      reason: 'Every supplier had two candidates too close to call.',
    };
  }

  // Strongest overall — the line's product identity. Which supplier actually
  // gets the order is decided later, on price, by the allocation engine.
  const primary = [...selected].sort(
    (a, b) => b.finalConfidence - a.finalConfidence || a.candidateIndex - b.candidateIndex,
  )[0]!;

  return {
    status: 'selected',
    selected,
    primary,
    excluded,
    reason:
      selected.length === 1
        ? `Selected from ${selected[0]!.supplier}.`
        : `Selected one product from each of ${selected.length} suppliers — allocation decides on price.`,
  };
}

/** Build a rule-engine candidate from a raw supplier card. */
export function candidateFromCard(
  supplier: string,
  card: SearchCard,
  exVatCasePrice?: number,
): RuleCandidate {
  // `packOfCard` refuses to invent a 1×1 pack when the card states none, which
  // `normalizeCard`'s caseConfig does not — use it so "unknown" stays unknown.
  const pack = packOfCard(card);
  return {
    supplier,
    name: card.name,
    ...(card.brand ? { brand: card.brand } : {}),
    ...(card.eanText ? { ean: card.eanText } : {}),
    ...(card.supplierSku ? { sku: card.supplierSku } : {}),
    ...(card.imageUrl ? { imageUrl: card.imageUrl } : {}),
    ...(pack ? { unitsPerCase: pack.unitsPerCase, unitSize: pack.unitSize } : {}),
    // Read from the RAW card name, before normalization strips them.
    ...(containerOf(card.name) ? { container: containerOf(card.name)! } : {}),
    // Read from the RAW card name, before normalization strips them. The
    // `unitsPerCase` guard still applies — a name restating its own case
    // ("Coke 24 Pack" on a 24-per-case product) is not a multipack.
    ...(normalizeProduct(card.name, { supplier }).extractedMetadata.form
      ? { form: normalizeProduct(card.name, { supplier }).extractedMetadata.form! }
      : {}),
    ...(multipackCount(card.name, pack?.unitsPerCase) !== undefined
      ? { multipack: multipackCount(card.name, pack?.unitsPerCase)! }
      : {}),
    ...(normalizeProduct(card.name, { supplier }).extractedMetadata.abv !== undefined
      ? { abv: normalizeProduct(card.name, { supplier }).extractedMetadata.abv! }
      : {}),
    ...(card.uom ? { uom: card.uom } : uomFromText(card.sizeText ?? '') ? { uom: uomFromText(card.sizeText ?? '')! } : {}),
    ...(exVatCasePrice !== undefined && Number.isFinite(exVatCasePrice)
      ? { exVatCasePrice }
      : {}),
  };
}
