/**
 * Generic compound-word splitter.
 *
 *   BLACKMINT → BLACK MINT        SPEARMINT → SPEAR MINT
 *
 * No dictionary of compounds. The vocabulary is built from the CORPUS being
 * matched — every token the suppliers used for this line — so a token is split
 * only when both halves are words that genuinely occur in this product space.
 * That is what makes it generic: it learns from the data in front of it instead
 * of from a list someone has to keep extending.
 *
 * Why corpus-derived rather than an English dictionary
 * ---------------------------------------------------
 * An English dictionary would split "CARAMEL" into "CAR" + "AMEL"-ish garbage
 * and would not know retail coinages at all. The supplier catalogue for one
 * product line is a far better vocabulary: if a supplier wrote "Black Mint" as
 * two words anywhere, "BLACKMINT" is almost certainly the same thing.
 *
 * Safety
 * ------
 * Splitting is symmetric — both the retailer's text and the supplier's go
 * through it — so a split can only ever make two descriptions of the same
 * product agree. It cannot merge genuinely different products: "SPEAR MINT" and
 * "PEPPER MINT" still differ on their first half.
 *
 * A token is left alone unless exactly one split is defensible. Ambiguity is
 * resolved by leaving the word intact, never by guessing.
 */

/** Shortest half a split may produce. Below this, splits are noise. */
const MIN_PART_LENGTH = 3;
/** Shortest token worth attempting to split at all. */
const MIN_TOKEN_LENGTH = 7;

export interface SplitResult {
  /** The token after splitting, or unchanged. */
  tokens: string[];
  /** True when a split was applied. */
  split: boolean;
}

/**
 * Split one token against a vocabulary.
 *
 * Returns every candidate split where BOTH halves are known words, then accepts
 * it only if there is exactly one — two plausible splits mean the token is
 * ambiguous and is safer left whole.
 */
export function splitCompound(token: string, vocabulary: ReadonlySet<string>): SplitResult {
  const word = token.toLowerCase();

  if (word.length < MIN_TOKEN_LENGTH) return { tokens: [token], split: false };
  // Already a known word on its own — never take it apart.
  if (vocabulary.has(word)) return { tokens: [token], split: false };
  if (!/^[a-z]+$/.test(word)) return { tokens: [token], split: false };

  const candidates: [string, string][] = [];
  for (let cut = MIN_PART_LENGTH; cut <= word.length - MIN_PART_LENGTH; cut++) {
    const left = word.slice(0, cut);
    const right = word.slice(cut);
    if (vocabulary.has(left) && vocabulary.has(right)) candidates.push([left, right]);
  }

  if (candidates.length !== 1) return { tokens: [token], split: false };
  return { tokens: candidates[0]!, split: true };
}

/** Split every token in a text against the vocabulary. */
export function splitCompounds(
  text: string,
  vocabulary: ReadonlySet<string>,
): { text: string; splits: { from: string; to: string }[] } {
  const splits: { from: string; to: string }[] = [];

  const tokens = text.split(/\s+/).filter(Boolean).flatMap((token) => {
    const result = splitCompound(token, vocabulary);
    if (result.split) splits.push({ from: token, to: result.tokens.join(' ') });
    return result.tokens;
  });

  return { text: tokens.join(' '), splits };
}

/**
 * Build a vocabulary from the texts available for one product line.
 *
 * Single letters and pure numbers are excluded — they make every long word
 * splittable and produce nothing but noise.
 */
export function buildVocabulary(texts: readonly string[]): Set<string> {
  const vocabulary = new Set<string>();
  for (const text of texts) {
    for (const token of text.toLowerCase().split(/[^a-z]+/)) {
      if (token.length >= MIN_PART_LENGTH) vocabulary.add(token);
    }
  }
  return vocabulary;
}
