/**
 * Result disambiguation.
 *
 * A description search on a supplier returns SEVERAL products (real examples:
 * "SMARTIES HEXATUBE" → 3, "KINDER BUENO" → 5, incl. White/Dark variants). We
 * must pick the ONE that matches the EPOS article — or flag it for a one-tap
 * human confirm when it's genuinely ambiguous.
 *
 * Signal, in priority order:
 *   1. Pack size — the EPOS file gives units-per-case × unit-size ("24 X 38.000"),
 *      and each supplier card shows its own ("24 x 38 g"). This is precise and
 *      usually decisive (it separated the 24×38 Smarties from the 4-pack/3-pack).
 *   2. Name similarity — token overlap separates same-pack variants
 *      ("Kinder Bueno" vs "Kinder Bueno Dark Chocolate Bar", both 30×43).
 *
 * Once a candidate is confirmed, its EAN + SKU + product URL are stored, and all
 * future refreshes use the direct URL (no search, no disambiguation).
 */

import { parseSizeText, type SearchCard } from './types.js';

export interface MatchTarget {
  /** EPOS description, e.g. "SMARTIES HEXATUBE". */
  description: string;
  /** EPOS pack, when known: units per case and unit size. */
  unitsPerCase?: number;
  unitSize?: number;
}

export interface ScoredCandidate {
  card: SearchCard;
  packScore: number; // 0..1
  nameScore: number; // 0..1
  score: number; // weighted total 0..1
}

export interface MatchDecision {
  best?: ScoredCandidate;
  ranked: ScoredCandidate[];
  /** True when the top result isn't clearly best — surface for one-tap confirm. */
  needsConfirm: boolean;
  reason: string;
}

const STOP = new Set(['the', 'a', 'of', 'and', '&', 'case', 'cs', 'pmp', 'pm', 'ea', 'each', 'std', 'standard']);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t)),
  );
}

/**
 * Name similarity: reward covering the EPOS name's words (handles a supplier
 * adding a brand prefix, e.g. "Nestle Smarties Hexatube" vs "SMARTIES HEXATUBE")
 * while penalizing EXTRA candidate words (separates "Kinder Bueno" from
 * "Kinder Bueno Dark Chocolate Bar", both 30×43).
 */
function nameSimilarity(target: string, candidate: string): number {
  const a = tokens(target);
  const b = tokens(candidate);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const coverage = inter / a.size; // fraction of the EPOS words the candidate has
  const extra = b.size - inter; // candidate words NOT in the EPOS name
  const extraPenalty = Math.min(0.7, extra * 0.2);
  return coverage * (1 - extraPenalty);
}

function packScore(target: MatchTarget, card: SearchCard): number {
  if (!target.unitsPerCase || !target.unitSize) return 0.5; // unknown → neutral
  const pack = card.unitsPerCase && card.unitSize
    ? { unitsPerCase: card.unitsPerCase, unitSize: card.unitSize }
    : parseSizeText(card.sizeText ?? '');
  if (!pack.unitsPerCase) return 0.3;
  const upcMatch = pack.unitsPerCase === target.unitsPerCase;
  const sizeMatch = Math.abs(pack.unitSize - target.unitSize) <= Math.max(0.5, target.unitSize * 0.02);
  if (upcMatch && sizeMatch) return 1;
  if (upcMatch) return 0.55;
  if (sizeMatch) return 0.4;
  return 0;
}

/**
 * Rank candidates against the target and decide whether the top is confident.
 * Weights pack size higher than name (it's the precise signal).
 */
export function pickBestMatch(target: MatchTarget, cards: SearchCard[]): MatchDecision {
  if (cards.length === 0) return { ranked: [], needsConfirm: false, reason: 'No search results.' };

  const ranked: ScoredCandidate[] = cards
    .map((card) => {
      const p = packScore(target, card);
      const n = nameSimilarity(target.description, card.name);
      return { card, packScore: p, nameScore: n, score: 0.6 * p + 0.4 * n };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0]!;
  const second = ranked[1];
  const margin = second ? best.score - second.score : 1;

  let needsConfirm = false;
  let reason = 'Confident: clear best match on pack size and name.';
  if (best.score < 0.5) {
    needsConfirm = true;
    reason = 'Low confidence — no candidate matches pack size/name well.';
  } else if (margin < 0.15) {
    needsConfirm = true;
    reason = 'Ambiguous — top two candidates are close; confirm which is correct.';
  } else if (best.packScore < 1 && target.unitsPerCase) {
    needsConfirm = true;
    reason = 'Best name match but pack size differs — confirm the pack is right.';
  }

  return { best, ranked, needsConfirm, reason };
}
