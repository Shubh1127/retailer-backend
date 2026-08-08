/**
 * Commercial equivalence — resolving "two candidates, too close to call".
 *
 * THE PROBLEM THIS SOLVES
 *
 * `selectFinal` drops a whole supplier when its two best candidates score
 * within `AMBIGUITY_MARGIN` and are not the same SKU. That rule is right when
 * the two are genuinely different products, and wrong when they are the SAME
 * product listed twice under different retail decoration:
 *
 *   "Pouch M&ms Crispy"        €18.89
 *   "Std - M&ms Crispy Bag"    €19.40
 *
 * Every deterministic rule passes for both, because both ARE the product the
 * line asked for. There is nothing for a human to review: one is simply cheaper.
 * Measured on a real order file, 81 of 112 remaining failures were this shape.
 *
 * WHAT MAKES TWO LISTINGS THE SAME COMMERCIAL PRODUCT
 *
 * Strip everything that describes how the LINE is sold rather than what the
 * PRODUCT is — price marks, PM/PMP/RSP, promotion text, "Std", containers,
 * pack counts — and compare what remains. That stripping already exists and is
 * already trusted: `normalizedIdentity` is the same function the rule engine
 * and reconciliation compare on, driven by `config/normalization.json`. Adding
 * a second, private notion of identity here would be how the two quietly drift
 * apart, so there is none.
 *
 * Text alone is not enough, though. Two listings can normalize to the same
 * words and still be different pack sizes, so the STRUCTURAL attributes are
 * compared too — units per case, unit size, container, form, multipack, ABV —
 * and a stated disagreement on any of them blocks the merge.
 *
 * WHY THIS IS SAFE
 *
 * It changes WHICH candidate is offered, never whether it is verified.
 * Reconciliation runs after this, unchanged, against the Excel line. A cheapest
 * candidate that turns out not to match the request is still blocked at the
 * gate exactly as it was before.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never merges two products that differ by variant, flavour, size or
 * strength. "Snickers Bar" vs "Snickers Duo", "Coke Zero" vs "Coke Original"
 * and "Kinder Bueno" vs "Kinder Bueno White" all survive normalization as
 * different strings and stay ambiguous — which is correct, because choosing
 * between them is a commercial decision, not a lookup.
 */

import { normalizedIdentity } from '../normalization/productNormalization.js';
import {
  AMBIGUITY_MARGIN,
  type CandidateJudgement,
  type FinalSelection,
  type RuleCandidate,
  type SelectedCandidate,
} from './ruleEngine.js';

/** Wording the dashboard shows for a line this stage settled. */
export const EQUIVALENT_EXPLANATION =
  'Equivalent commercial products found; selected the cheapest verified supplier.';

/** Wording for a line it refused to settle. */
export const DIFFERENT_EXPLANATION =
  'Commercially different products remain; manual review required.';

/** What happened to one supplier's ambiguous group. */
export interface EquivalenceResolution {
  supplier: string;
  resolved: boolean;
  /** The shared commercial identity, when they agreed on one. */
  identity?: string;
  /** The distinct identities found, when they did not. */
  identities?: string[];
  /** Attributes that disagreed, when a structural difference blocked the merge. */
  conflicts?: string[];
  candidateIndexes: number[];
  /** Ex-VAT case price of the candidate taken, when resolved. */
  chosenPrice?: number;
  /** What taking the cheapest saved against the dearest equivalent. */
  saving?: number;
  reason: string;
}

export interface EquivalenceOutcome {
  selection: FinalSelection;
  resolutions: EquivalenceResolution[];
  /** Present when this stage had something to say about the line. */
  explanation?: string;
}

/**
 * The commercial identity of a listing: normalized, tokenized, sorted, unique.
 *
 * Sorted because word ORDER is catalogue style, not identity — "Pouch M&ms
 * Crispy" and "M&ms Crispy Bag" name one product. Comparing the raw normalized
 * strings would make those two different and leave the buyer choosing between a
 * product and itself.
 */
/**
 * Repair currency symbols that lost their encoding upstream.
 *
 * Supplier feeds carry price marks whose euro sign has been mangled — "?2.20",
 * "&euro;2" — and `config/normalization.json`'s price patterns quite reasonably
 * match "€", "EUR" and "£" rather than a question mark. The result was that a
 * price mark survived into the commercial identity and made one product look
 * like several:
 *
 *   "drs energy lucozade original"  vs  "?2.20 drs energy lucozade original"
 *   "bull drs red"  vs  "?2.90 bull drs red"  vs  "?2.30 bull drs red"
 *
 * Restoring the symbol lets the EXISTING, already-trusted price stripping do
 * the work, rather than adding a second way to recognise a price. Done here
 * rather than in `productNormalization` because that module is shared with the
 * rule engine and reconciliation, and widening what they strip is not part of
 * this change.
 *
 * A bare "?" or replacement character immediately before a price-shaped number
 * is the only thing rewritten. Product names do not otherwise contain one.
 */
/**
 * Category nouns that name what a thing IS in general, never which one it is.
 *
 * Scoped DELIBERATELY to this comparison and nowhere else. `normalization.json`
 * carries an explicit warning against deleting words like these globally —
 * "deleting identity words to force a match is unfalsifiable" — and that
 * warning is right for the rule engine, which compares a candidate against the
 * ORDER LINE and where a deleted word could hide a real difference.
 *
 * Here the comparison is between two candidates that have ALREADY passed the
 * rule engine against the same order line and scored within the ambiguity
 * margin of each other. The question is no longer "is this the right product"
 * but "are these two the same listing twice", and on that question:
 *
 *   "Lucozade Sport Raspberry"        €X
 *   "Lucozade Sport Raspberry Drink"  €Y
 *
 * differ by a word that distinguishes nothing. Product FORM is compared
 * separately, so a powder or tablet version cannot be merged in this way.
 *
 * KEPT DELIBERATELY TINY. Measured over 63 refusals on a real order file, only
 * six were single-word differences and five of those were CORRECT — `zero`,
 * `duo`, `vanilla` and `0.0` all name genuinely different products, and `0.0`
 * separates alcohol-free from alcoholic. A larger list would start merging
 * those, so nothing goes in here without evidence that it distinguishes
 * nothing.
 */
const GENERIC_CATEGORY_NOUNS = new Set(['drink', 'drinks', 'beverage', 'beverages']);

function repairPriceMarks(name: string): string {
  return name
    .replace(/&euro;?/gi, '€')
    .replace(/&pound;?/gi, '£')
    .replace(/[?�](?=\s?\d)/g, '€');
}

export function commercialIdentity(candidate: RuleCandidate): string {
  const normalized = normalizedIdentity(repairPriceMarks(candidate.name), {
    supplier: candidate.supplier,
  });
  return [
    ...new Set(
      normalized
        .split(/\s+/)
        // Punctuation-only tokens are not identity. `normalizeProduct` strips
        // brackets and quotes but leaves dashes, so a catalogue writing
        // "Std - M&ms Crispy Bag" reduces to "- m&ms crispy" and a lone hyphen
        // was enough to make one product look like two. Filtered HERE rather
        // than in the shared normalizer, which the rule engine and
        // reconciliation also compare on and which is not mine to change.
        .filter((token) => /[a-z0-9]/i.test(token))
        .filter((token) => !GENERIC_CATEGORY_NOUNS.has(token.toLowerCase())),
    ),
  ]
    .sort()
    .join(' ');
}

/**
 * Structural attributes that must not disagree.
 *
 * Compared ONLY where both sides state a value. An unknown is not a conflict —
 * the same convention the rule engine uses, and for the same reason: treating
 * silence as disagreement would reject on the absence of evidence.
 */
function structuralConflicts(a: RuleCandidate, b: RuleCandidate): string[] {
  const conflicts: string[] = [];

  const compare = <T>(label: string, left: T | undefined, right: T | undefined) => {
    if (left === undefined || right === undefined) return;
    if (left !== right) conflicts.push(`${label} ${String(left)} vs ${String(right)}`);
  };

  compare('units per case', a.unitsPerCase, b.unitsPerCase);
  compare('unit size', a.unitSize, b.unitSize);
  compare('unit of measure', a.uom, b.uom);
  compare('container', a.container?.toLowerCase(), b.container?.toLowerCase());
  compare('form', a.form?.toLowerCase(), b.form?.toLowerCase());
  compare('multipack', a.multipack, b.multipack);
  compare('alcohol by volume', a.abv, b.abv);

  return conflicts;
}

interface Tied {
  judgement: CandidateJudgement;
  candidate: RuleCandidate;
}

function isOrderable(candidate: RuleCandidate): boolean {
  return (
    Boolean(candidate.sku) &&
    candidate.exVatCasePrice !== undefined &&
    Number.isFinite(candidate.exVatCasePrice) &&
    candidate.exVatCasePrice > 0
  );
}

function toSelected(tied: Tied, reason: string): SelectedCandidate {
  const { judgement, candidate } = tied;
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
    finalConfidence: judgement.finalConfidence,
    sbertSimilarity: judgement.sbertSimilarity,
    reason,
  };
}

/**
 * Settle every "too close to call" exclusion that is not actually a choice.
 *
 * Runs AFTER `selectFinal` and BEFORE reconciliation. It only ever ADDS to the
 * selection — a group it cannot settle is left excluded exactly as the rule
 * engine left it, so the worst case is the behaviour that existed before.
 */
export function resolveCommercialEquivalence(
  selection: FinalSelection,
  candidates: readonly RuleCandidate[],
  judgements: readonly CandidateJudgement[],
  enabled = true,
): EquivalenceOutcome {
  // The off switch exists so the stage can be A/B'd against itself on real
  // data. Without it "before" and "after" would be two different builds, and a
  // comparison across builds proves nothing about this stage in particular.
  if (!enabled) return { selection, resolutions: [] };

  const ambiguous = selection.excluded.filter((exclusion) => exclusion.needsAiReview);
  if (ambiguous.length === 0) return { selection, resolutions: [] };

  const byIndex = new Map<number, RuleCandidate>();
  for (const judgement of judgements) {
    const candidate = candidates[judgement.candidateIndex];
    if (candidate) byIndex.set(judgement.candidateIndex, candidate);
  }

  const resolutions: EquivalenceResolution[] = [];
  const added: SelectedCandidate[] = [];
  const settled = new Set<string>();

  for (const exclusion of ambiguous) {
    // Rebuild the group the rule engine could not separate: its passing,
    // orderable candidates from this supplier that sit within AMBIGUITY_MARGIN
    // of the best one. Candidates further down were never ambiguous, so
    // demanding that they agree too would refuse cases that are not in doubt.
    const supplierPasses: Tied[] = judgements
      .filter(
        (judgement) =>
          judgement.decision === 'PASS' &&
          byIndex.get(judgement.candidateIndex)?.supplier === exclusion.supplier,
      )
      .map((judgement) => ({ judgement, candidate: byIndex.get(judgement.candidateIndex)! }))
      .filter((tied) => isOrderable(tied.candidate));

    if (supplierPasses.length < 2) continue;

    const best = supplierPasses.reduce((leader, tied) =>
      tied.judgement.breakdown.base > leader.judgement.breakdown.base ? tied : leader,
    );
    const tied = supplierPasses.filter(
      (entry) => best.judgement.breakdown.base - entry.judgement.breakdown.base < AMBIGUITY_MARGIN,
    );

    const identities = [...new Set(tied.map((entry) => commercialIdentity(entry.candidate)))];

    // Every pair, not just against the best: a group is one product only if all
    // of it is one product.
    const conflicts: string[] = [];
    for (let i = 0; i < tied.length; i += 1) {
      for (let j = i + 1; j < tied.length; j += 1) {
        conflicts.push(...structuralConflicts(tied[i]!.candidate, tied[j]!.candidate));
      }
    }
    const uniqueConflicts = [...new Set(conflicts)];

    if (identities.length > 1 || uniqueConflicts.length > 0) {
      resolutions.push({
        supplier: exclusion.supplier,
        resolved: false,
        identities,
        ...(uniqueConflicts.length > 0 ? { conflicts: uniqueConflicts } : {}),
        candidateIndexes: tied.map((entry) => entry.judgement.candidateIndex),
        reason:
          identities.length > 1
            ? `Genuinely different products: ${identities.map((id) => `"${id}"`).join(' vs ')}.`
            : `Same product name but ${uniqueConflicts.join('; ')}.`,
      });
      continue;
    }

    // One commercial product, several listings. Price is the only thing left
    // that distinguishes them, so it decides.
    const cheapest = tied.reduce((leader, entry) =>
      (entry.candidate.exVatCasePrice ?? Infinity) < (leader.candidate.exVatCasePrice ?? Infinity)
        ? entry
        : leader,
    );
    const prices = tied
      .map((entry) => entry.candidate.exVatCasePrice)
      .filter((price): price is number => price !== undefined);
    const dearest = Math.max(...prices);
    const chosenPrice = cheapest.candidate.exVatCasePrice!;

    added.push(
      toSelected(
        cheapest,
        `Cheapest of ${tied.length} equivalent listings from ${exclusion.supplier}.`,
      ),
    );
    settled.add(exclusion.supplier);

    resolutions.push({
      supplier: exclusion.supplier,
      resolved: true,
      identity: identities[0]!,
      candidateIndexes: tied.map((entry) => entry.judgement.candidateIndex),
      chosenPrice,
      saving: Number((dearest - chosenPrice).toFixed(2)),
      reason:
        `${tied.length} listings of "${identities[0]}" from ${exclusion.supplier} — ` +
        `took the cheapest at €${chosenPrice.toFixed(2)}` +
        (dearest > chosenPrice ? ` (€${(dearest - chosenPrice).toFixed(2)} below the dearest)` : ''),
    });
  }

  if (added.length === 0) {
    return {
      selection,
      resolutions,
      ...(resolutions.length > 0 ? { explanation: DIFFERENT_EXPLANATION } : {}),
    };
  }

  const selected = [...selection.selected, ...added];
  const primary = [...selected].sort(
    (a, b) => b.finalConfidence - a.finalConfidence || a.candidateIndex - b.candidateIndex,
  )[0]!;

  return {
    selection: {
      ...selection,
      status: 'selected',
      selected,
      primary,
      // A settled supplier is no longer excluded; one still in doubt stays so.
      excluded: selection.excluded.filter(
        (exclusion) => !(exclusion.needsAiReview && settled.has(exclusion.supplier)),
      ),
      reason:
        selection.selected.length === 0
          ? `Selected ${added.length} supplier(s) after resolving equivalent listings.`
          : `${selection.reason} ${added.length} further supplier(s) resolved as equivalent listings.`,
    },
    resolutions,
    explanation: EQUIVALENT_EXPLANATION,
  };
}
