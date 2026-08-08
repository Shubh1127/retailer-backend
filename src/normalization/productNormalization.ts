/**
 * Product normalization — the layer that runs before search and SBERT.
 *
 *   Excel → PRODUCT NORMALIZATION → search → SBERT → rules → reconciliation
 *
 * The problem it solves
 * ---------------------
 * The false negatives measured against live data were not AI failures. They
 * were vocabulary failures — four parties describing one product four ways:
 *
 *   EPOS export        LUCOZADE ZERO ORIGINAL BTL €2.20
 *   retailer shorthand FISHERMANS FRIEND BLACKCURRANT LOZ
 *   supplier catalogue Nestle Std Smarties Hexatube
 *   marketing copy     Halls Extra Strong Menthol Action Sweets
 *
 * Sending any of those verbatim to a supplier's search box, or to a sentence
 * encoder, asks it to see past noise that we can simply remove first.
 *
 * Nothing is discarded
 * --------------------
 * A shelf price, a "CASE" flag and a container are all real information about
 * the order line. They are moved to `extractedMetadata`, not deleted — the
 * container in particular is still compared, as its own attribute, by the rule
 * engine. Removing it from the TEXT stops it being compared twice.
 *
 * No product knowledge in this file
 * ---------------------------------
 * Every word this module acts on comes from `config/normalization.json`. There
 * is no product name, brand or supplier phrase anywhere in the code. Growing the
 * dictionary improves matching; the code does not change.
 */

import { decorationsFor, getConfig } from './config.js';
import { cleanSearchQuery } from '../connectors/types.js';
import { categoryOf } from '../parsing/tokenCategory.js';

/** What normalization found and set aside. Nothing here is lost. */
export interface ExtractedMetadata {
  /** Prices embedded in the description, in the order they appeared. */
  prices: number[];
  /** Raw price text as written, e.g. "€2.20". */
  priceText: string[];
  /** Retailer-only flags found and removed ("case", "pmp"). */
  retailFlags: string[];
  /** Container form factor, when the text stated one. */
  container?: string;
  /** Physical product form ("gum", "roll"), when the text stated one. */
  form?: string;
  /** Piece / unit count a retailer appended ("46P" → 46). */
  pieceCount?: number;
  /**
   * Alcohol by volume, when stated. 0 marks an alcohol-free product, which is a
   * DIFFERENT commercial product from the same brand at full strength.
   */
  abv?: number;
  /**
   * Multipack count ("10 PACK" → 10). Commercially meaningful — a 10-pack is
   * not a single — but a QUANTITY, so it is compared as its own attribute
   * rather than sitting inside the product's name.
   */
  multipackCount?: number;
  /** Abbreviations that were expanded. */
  expansions: { from: string; to: string }[];
  /** Multi-word synonyms that were canonicalised. */
  synonyms: { from: string; to: string }[];
  /** Supplier catalogue decoration removed ("std", "chewy"). */
  decorations: string[];
  /** Brands recognised in the text, whose scoped synonyms were applied. */
  brands: string[];
}

/** One visible transformation, so no step is hidden from a trace. */
export interface NormalizationStep {
  /** Stage name, in execution order. */
  stage: string;
  before: string;
  after: string;
  /** What this stage did, or "none" when it changed nothing. */
  detail: string;
}

export interface NormalizedProduct {
  /** Exactly what came in. */
  originalQuery: string;
  /**
   * The commercial product name alone. This is what goes to the supplier search
   * boxes, to SBERT, and into identity comparison.
   */
  normalizedQuery: string;
  extractedMetadata: ExtractedMetadata;
  /** Every stage, in order, with its before/after. Drives the debug report. */
  steps: NormalizationStep[];
}

export interface NormalizeOptions {
  /**
   * Supplier whose catalogue this text came from, so its own decoration list
   * applies. Omit for retailer text.
   */
  supplier?: string;
  /**
   * Keep container words in the query. Off by default: the rule engine compares
   * containers as a separate attribute, so leaving them in double-counts them.
   */
  keepContainer?: boolean;
}

function emptyMetadata(): ExtractedMetadata {
  return {
    prices: [],
    priceText: [],
    retailFlags: [],
    expansions: [],
    synonyms: [],
    decorations: [],
    brands: [],
  };
}

/** "€2.20" | "2,20 EUR" → 2.2 */
function parsePriceText(text: string): number | undefined {
  const match = text.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match) return undefined;
  const value = Number(match[1]!.replace(',', '.'));
  return Number.isFinite(value) ? value : undefined;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize one product description.
 *
 * The order of the steps is load-bearing:
 *
 *   prices → abbreviations → synonyms → retail noise → container → decorations
 *
 * Abbreviations expand BEFORE containers are removed, which is why "BTL"
 * vanishes from the query (it becomes "bottle", then a container) while "LOZ"
 * survives as "lozenges" — a product form, not packaging. Reversing those two
 * steps would either keep "BTL" as a mystery token or wrongly strip "LOZENGES".
 */
export function normalizeProduct(
  input: string,
  opts: NormalizeOptions = {},
): NormalizedProduct {
  const originalQuery = input ?? '';
  const metadata = emptyMetadata();
  const config = getConfig();

  // Every stage records what it did, so a debug report can show the whole
  // lifecycle without anyone re-reading this function.
  const steps: NormalizationStep[] = [];
  let stepBefore = originalQuery;
  const record = (stage: string, after: string, detail: string) => {
    steps.push({ stage, before: stepBefore, after, detail: detail || 'none' });
    stepBefore = after;
  };

  // --- 0. HTML entities ----------------------------------------------------
  // Supplier feeds carry encoded punctuation ("M&M&apos;s Crispy"). This MUST
  // run before punctuation is stripped: removing the entity's semicolon first
  // leaves "&apos" glued to the word, which the ampersand rule downstream then
  // fuses into a nonsense token like "wrigleyapos".
  let text = originalQuery
    .toLowerCase()
    .replace(/&apos;|&#0*39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&#0*34;/g, '"')
    .replace(/&amp;|&#0*38;/g, '&')
    .replace(/&nbsp;|&#0*160;/g, ' ');

  // --- 1. Prices → metadata ------------------------------------------------
  for (const pattern of config.pricePatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      continue; // a bad pattern in config must not break the pipeline
    }
    text = text.replace(regex, (match) => {
      metadata.priceText.push(match.trim());
      const value = parsePriceText(match);
      if (value !== undefined) metadata.prices.push(value);
      return ' ';
    });
  }

  record(
    'Prices removed',
    text.replace(/\s+/g, ' ').trim(),
    metadata.priceText.join(', '),
  );

  // --- 1b. Piece counts → metadata -----------------------------------------
  // "46P" is retail metadata, not commercial identity. The tracer proved it
  // suppresses the supplier search outright, so it must never reach the query.
  // Extracted BEFORE abbreviations, so "46p" is not mangled into "46 pack".
  for (const pattern of config.pieceCountPatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      continue;
    }
    text = text.replace(regex, (_match, count: string) => {
      const value = Number(count);
      if (Number.isFinite(value) && metadata.pieceCount === undefined) {
        metadata.pieceCount = value;
      }
      return ' ';
    });
  }

  record(
    'Piece count removed',
    text.replace(/\s+/g, ' ').trim(),
    
    metadata.pieceCount !== undefined ? String(metadata.pieceCount) : '',
  );

  // --- 1c. Alcohol by volume → metadata ------------------------------------
  // SAFETY-CRITICAL, and a FIELD rather than text.
  //
  // Injecting a synthetic "alcoholfree" token instead was tried and broke the
  // search: the canonical is also the query, and no supplier writes that word,
  // so every alcohol-free line returned zero results. ABV is compared as its
  // own attribute — see the `alcoholMatch` rule — which keeps the query
  // searchable AND the comparison safe.
  for (const pattern of config.abvPatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      continue;
    }
    text = text.replace(regex, (_match, value: string) => {
      const abv = Number(value);
      if (Number.isFinite(abv) && metadata.abv === undefined) metadata.abv = abv;
      return ' ';
    });
  }

  record(
    'Alcohol by volume removed',
    text.replace(/\s+/g, ' ').trim(),
    metadata.abv !== undefined
      ? `${metadata.abv}%${metadata.abv === 0 ? ' → alcoholfree variant' : ''}`
      : '',
  );

  // Punctuation that only ever separates. Ampersands and slashes are kept here
  // because "NUTELLA & GO" and "S/F" are part of the name at this stage.
  text = text.replace(/[,;:()[\]{}"']/g, ' ').replace(/\s+/g, ' ').trim();

  let tokens = text.split(' ').filter(Boolean);

  // --- 2. Abbreviations ----------------------------------------------------
  //
  // Retailers glue a count to the abbreviation — "10PK", "6BTL" — so the token
  // never matches the dictionary and the shorthand reaches the supplier's search
  // box verbatim, returning nothing. Split only when the alphabetic tail is a
  // KNOWN abbreviation, which leaves measures like "330ml" untouched (there is
  // no "ml" abbreviation, and the measure is read elsewhere).
  tokens = tokens.flatMap((token) => {
    const glued = token.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
    if (glued && config.abbreviations[glued[2]!]) return [glued[1]!, glued[2]!];
    return [token];
  });

  tokens = tokens.flatMap((token) => {
    const expansion = config.abbreviations[token];
    if (!expansion) return [token];
    metadata.expansions.push({ from: token, to: expansion });
    return expansion.split(' ');
  });

  record(
    'Expanded abbreviations',
    tokens.join(' '),
    metadata.expansions.map((e) => `${e.from} → ${e.to}`).join(', '),
  );

  // --- 2b. Multipack count → metadata --------------------------------------
  // Runs straight after abbreviations so "10PK" has already become "10 PACK".
  // The count is a quantity, not part of the name: keeping it in the canonical
  // put a pack count in the search box and inside identity comparison.
  {
    let joinedForMultipack = tokens.join(' ');
    for (const pattern of config.multipackPatterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gi');
      } catch {
        continue;
      }
      joinedForMultipack = joinedForMultipack.replace(regex, (_match, count: string) => {
        const value = Number(count);
        // A multipack of one is not a multipack.
        if (Number.isFinite(value) && value > 1 && metadata.multipackCount === undefined) {
          metadata.multipackCount = value;
        }
        return ' ';
      });
    }
    tokens = joinedForMultipack.split(/\s+/).filter(Boolean);
  }

  record(
    'Multipack count removed',
    tokens.join(' '),
    metadata.multipackCount !== undefined ? String(metadata.multipackCount) : '',
  );

  // --- 3. Synonyms ---------------------------------------------------------
  //
  // Global equivalences first, then those scoped to a brand that the text
  // actually names. Both are applied longest-phrase-first so a shorter key can
  // never consume the head of a longer one — "no added sugar" must win over
  // "no sugar", or the leading "no" is orphaned.
  let joined = tokens.join(' ');

  const applySynonyms = (map: Record<string, string>, scope: string) => {
    const entries = Object.entries(map).sort(
      (a, b) => b[0].split(' ').length - a[0].split(' ').length,
    );
    for (const [phrase, canonical] of entries) {
      if (phrase === canonical || phrase.startsWith('$')) continue;
      const regex = new RegExp(`(?<![a-z0-9])${escapeRegex(phrase)}(?![a-z0-9])`, 'g');
      if (!regex.test(joined)) continue;
      metadata.synonyms.push({
        from: `${scope === '*' ? '' : `${scope}: `}${phrase}`,
        to: canonical,
      });
      // An empty canonical DELETES the phrase — the only way to drop a word for
      // one brand alone ("cola" is a category for Pepsi, a name for Coca-Cola).
      joined = joined.replace(regex, canonical || ' ');
    }
    joined = joined.replace(/\s+/g, ' ').trim();
  };

  const globalBefore = metadata.synonyms.length;
  applySynonyms(config.synonyms, '*');
  record(
    'Global synonyms',
    joined,
    metadata.synonyms
      .slice(globalBefore)
      .map((s) => `${s.from} → ${s.to}`)
      .join(', '),
  );

  // A brand's map applies only when the text names that brand, so an
  // equivalence true for one range cannot leak into another.
  const brandBefore = metadata.synonyms.length;
  for (const [brand, map] of Object.entries(config.brandSynonyms)) {
    const brandPresent = new RegExp(
      `(?<![a-z0-9])${escapeRegex(brand)}(?![a-z0-9])`,
    ).test(joined);
    if (!brandPresent) continue;
    metadata.brands.push(brand);
    applySynonyms(map, brand);
  }
  record(
    'Brand synonyms',
    joined,
    metadata.brands.length === 0
      ? ''
      : `${metadata.brands.join(', ')} — ` +
        (metadata.synonyms
          .slice(brandBefore)
          .map((s) => `${s.from} → ${s.to}`)
          .join(', ') || 'brand recognised, no rewrite'),
  );

  tokens = joined.split(' ').filter(Boolean);

  // --- 4. Retailer noise → metadata ---------------------------------------
  const retailNoise = new Set(config.retailNoise);
  tokens = tokens.filter((token) => {
    if (!retailNoise.has(token)) return true;
    metadata.retailFlags.push(token);
    return false;
  });

  // Packaging nouns that are noise alone but meaningful when counted:
  // "HALLS SOOTHERS CHERRY PACK" drops "pack"; "SMARTIES HEXATUBE 4 PACK"
  // keeps it, because "4 pack" is the multipack signal that separates a
  // single from a 4-pack.
  // Driven by the token-category registry, not a parallel list: `packaging` is
  // one category, so "case", "each", "outer" and "pack" are all removed by the
  // same rule. Keeping a second list here is how a token ends up in two
  // categories, which the registry exists to forbid.
  tokens = tokens.filter((token, index) => {
    const isPackaging =
      categoryOf(token) === 'packaging' || config.countableNoise.includes(token);
    if (!isPackaging) return true;
    const previous = tokens[index - 1];
    if (previous !== undefined && /^\d+(?:\.\d+)?$/.test(previous)) return true;
    metadata.retailFlags.push(token);
    return false;
  });

  record('Removed retail words', tokens.join(' '), metadata.retailFlags.join(', '));

  // --- 5. Container → metadata --------------------------------------------
  const containers = new Set(config.containers);
  tokens = tokens.filter((token) => {
    if (!containers.has(token)) return true;
    // First container wins; a name stating two is not a usable signal anyway.
    if (metadata.container === undefined) metadata.container = singularize(token);
    return opts.keepContainer === true;
  });

  record(
    'Containers removed',
    tokens.join(' '),
    metadata.container ?? '',
  );

  // --- 5b. Product form → metadata -----------------------------------------
  // "GUM" describes the form, not which product it is. Both sides are stripped
  // identically, and the form is compared as its own attribute — same treatment
  // as a container, and for the same reason.
  const forms = new Set(config.productForms);
  tokens = tokens.filter((token) => {
    if (!forms.has(token)) return true;
    if (metadata.form === undefined) metadata.form = singularize(token);
    return false;
  });

  record('Product form removed', tokens.join(' '), metadata.form ?? '');

  // --- 6. Supplier decoration ---------------------------------------------
  const decorations = decorationsFor(opts.supplier);
  tokens = tokens.filter((token) => {
    if (!decorations.has(token)) return true;
    metadata.decorations.push(token);
    return false;
  });

  const normalizedQuery = tokens.join(' ').trim();
  record(
    'Marketing decorations removed',
    normalizedQuery,
    metadata.decorations.join(', '),
  );

  return { originalQuery, normalizedQuery, extractedMetadata: metadata, steps };
}

/** Crude singular, matching the rule engine's own token handling. */
function singularize(token: string): string {
  return token.length >= 3 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
}

/**
 * THE canonical product string — the single source of truth.
 *
 * Supplier search, SBERT, the rule engine and reconciliation must all receive
 * this exact string. They previously did not: the search box got
 * `cleanSearchQuery(normalized)` while everything downstream got `normalized`,
 * so a line whose text ended in CASE/PMP/EACH was searched with one string and
 * judged against another. Any divergence means a product is matched against
 * something it was never searched for.
 *
 * `cleanSearchQuery` is folded in HERE rather than at the call site, so there is
 * exactly one place the canonical form is produced and no caller can reintroduce
 * a second variant.
 */
export function canonicalQuery(input: string, opts: NormalizeOptions = {}): string {
  return cleanSearchQuery(normalizeProduct(input, opts).normalizedQuery)
    .trim()
    .toUpperCase();
}

/**
 * The normalized query, upper-cased for display and for supplier search boxes.
 *
 * Suppliers' search is case-insensitive, but the retailer recognises their own
 * products in the upper case their EPOS export uses.
 */
export function normalizedQueryFor(input: string, opts: NormalizeOptions = {}): string {
  return normalizeProduct(input, opts).normalizedQuery.toUpperCase();
}

/**
 * Normalized identity text for comparison.
 *
 * Lower case and no display formatting — this feeds token comparison, not a
 * human. Kept separate from `normalizedQueryFor` so the two cannot drift.
 */
export function normalizedIdentity(input: string, opts: NormalizeOptions = {}): string {
  return normalizeProduct(input, opts).normalizedQuery;
}
