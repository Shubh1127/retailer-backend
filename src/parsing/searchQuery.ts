/**
 * Supplier search query generation — optimised for RECALL, not precision.
 *
 * The architectural split this file exists to enforce:
 *
 *   Canonical Product Identity   →  precision. What the rule engine and
 *                                   reconciliation compare. Must be exact.
 *   Supplier Search Query        →  recall. What goes in the search box. Must
 *                                   bring back every plausible candidate.
 *
 * These are DIFFERENT jobs and were previously one string, which is why an
 * identity improvement kept breaking retrieval: adding `alcoholfree` to the
 * identity made "GUINNESS DRAUGHT 0.0%" un-findable, because no supplier writes
 * that word. One string cannot be both maximally precise and maximally
 * permissive.
 *
 * Retrieval is a ladder, not a single shot
 * ----------------------------------------
 * Supplier search is keyword-AND: every extra token can only ever shrink the
 * result set, and one unrecognised token empties it. So queries are issued from
 * most to least specific and the results are UNIONED, stopping as soon as
 * enough candidates exist:
 *
 *   GUINNESS DRAUGHT 0.0 → 1     specific, exact
 *   GUINNESS DRAUGHT     → 8     broader, still on-brand
 *   GUINNESS             → 20+   widest
 *
 * Precision is then recovered downstream by SBERT re-ranking and the
 * deterministic rules, which is where it belongs. A candidate the rules would
 * have rejected costs one comparison; a candidate retrieval never returned
 * cannot be recovered at all.
 */

/** One rung of the ladder. */
export interface SearchQueryLevel {
  /** Most specific first, ascending as the query broadens. */
  level: number;
  query: string;
  /** Why this rung exists, for the debug report. */
  rationale: string;
}

export interface SearchQueryPlan {
  levels: SearchQueryLevel[];
}

/**
 * Enough candidates to stop broadening.
 *
 * Deliberately small: the ladder exists to escape ZERO results, not to drag back
 * the whole catalogue. Once the rules have something to judge, a broader query
 * adds noise without adding information.
 */
export const RECALL_TARGET = 5;

/** Never issue a query this short — a one-token query matches half the catalogue. */
const MIN_QUERY_TOKENS = 1;

export interface BuildQueryPlanInput {
  /** The precise identity: brand + core product. */
  canonicalIdentity: string;
  /** Distinguishing attributes worth trying in the FIRST, most specific query. */
  discriminators?: (string | number | undefined)[];
  /** Brand alone, when known — the widest sensible rung. */
  brand?: string;
}

/**
 * Build the ladder of queries for one product, most specific first.
 *
 * Duplicate and empty queries are removed, so the caller can issue them in order
 * without checking.
 */
export function buildSearchQueryPlan(input: BuildQueryPlanInput): SearchQueryPlan {
  const identity = input.canonicalIdentity.trim().toUpperCase();
  const tokens = identity.split(/\s+/).filter(Boolean);

  const levels: SearchQueryLevel[] = [];
  const push = (query: string, rationale: string) => {
    const normalized = query.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!normalized) return;
    if (normalized.split(' ').length < MIN_QUERY_TOKENS) return;
    if (levels.some((existing) => existing.query === normalized)) return;
    levels.push({ level: levels.length, query: normalized, rationale });
  };

  // Most specific: identity plus whatever distinguishes this line. Worth trying
  // because when it hits, the result set needs no filtering at all.
  const discriminators = (input.discriminators ?? [])
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String);
  if (discriminators.length > 0) {
    push(
      [identity, ...discriminators].join(' '),
      'identity plus distinguishing attributes — most specific',
    );
  }

  push(identity, 'canonical identity');

  // Progressively drop trailing tokens. Retail descriptions lead with the most
  // identifying words, so the tail is what to give up first.
  //
  // Down to ONE token. A two-token identity like "AIRWAVES BLACKMINT" otherwise
  // had no fallback at all — dropping one left a single token, which an earlier
  // `>= 2` floor rejected, so a compound typo in either word meant zero
  // candidates and no way to recover. A distinctive single token is a perfectly
  // good recall query; precision is restored downstream.
  for (let drop = 1; tokens.length - drop >= 1; drop++) {
    push(
      tokens.slice(0, tokens.length - drop).join(' '),
      `identity minus ${drop} trailing token(s)`,
    );
  }

  if (input.brand) push(input.brand, 'brand only — widest');

  return { levels };
}
