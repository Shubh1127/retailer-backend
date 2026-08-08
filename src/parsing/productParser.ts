/**
 * Product Parsing Engine — the single source of truth.
 *
 *   title → ParsedProduct { brand, product, variant, form, container, … }
 *
 * Every stage downstream consumes THIS, not the title. Normalization, SBERT,
 * the rule engine, reconciliation and allocation all read fields; none of them
 * parses a title of its own any more. That is the whole point: one parser means
 * one interpretation, and a new supplier needs no new stage-specific handling.
 *
 * How it avoids becoming another dictionary
 * -----------------------------------------
 * Fields are recovered by STRUCTURE wherever structure exists:
 *
 *   multipack, pieces, sizes   numeric patterns
 *   container, form            closed, product-agnostic vocabularies — a bottle
 *                              is a bottle in every category that ever ships
 *   variant                    formulation markers, a closed class that already
 *                              existed and is already tested
 *   brand                      the supplier's own brand field, else the leading
 *                              token(s) — retail descriptions lead with brand
 *   product                    whatever remains once all of the above is taken
 *                              out. It is a RESIDUAL, never a list.
 *
 * `product` being the residual is what stops this growing. Adding a flavour, a
 * sub-brand or a new range needs no configuration at all — unrecognised words
 * simply stay in the product identity, which is where they belong.
 *
 * Flavour is product, not variant
 * -------------------------------
 * "AIRWAVES BLACK MINT SUGARFREE GUM" parses to product "BLACK MINT",
 * variant "SUGARFREE". A flavour names WHICH product; a formulation names which
 * VERSION of it. Two Airwaves flavours are different products and must compare
 * as such — folding them into `variant` would make them look interchangeable.
 */

import { getConfig } from '../normalization/config.js';
import { normalizeProduct } from '../normalization/productNormalization.js';
import { FORMULATION_TOKENS } from '../services/matchConfidence.js';
import { splitCompounds } from './compoundSplitter.js';
import type { Uom } from '../types.js';

export interface ParsedProduct {
  /** Manufacturer or range owner, when identifiable. */
  brand?: string;
  /** The core commercial product — the residual after every other field. */
  product: string;
  /** Formulation version: zero, diet, sugarfree, dark, white. */
  variant?: string;
  /** Physical product form: gum, bar, lozenges. */
  form?: string;
  /** Packaging: bottle, can, box. */
  container?: string;
  /** Multipack count ("10 PACK" → 10). */
  multipack?: number;
  /** Piece / unit count ("46P" → 46). */
  pieceCount?: number;
  /** Size of one unit. */
  unitSize?: number;
  unit?: Uom;
  /** Units per case. */
  caseQuantity?: number;

  /**
   * Brand + core product, upper-cased. THE identity string: what goes to the
   * supplier search box and to SBERT. Contains no price, count, size, packaging
   * or decoration by construction — those all became fields above.
   */
  canonicalIdentity: string;

  /** What the parser did, for the debug report. */
  trace: {
    original: string;
    normalized: string;
    compoundSplits: { from: string; to: string }[];
    removed: { field: string; value: string }[];
  };
}

export interface ParseOptions {
  /** Supplier whose catalogue decorations apply. Omit for retailer text. */
  supplier?: string;
  /** Brand the supplier stated, which beats any guess from the text. */
  brand?: string;
  /** Structured pack the supplier stated, which beats anything in the title. */
  caseQuantity?: number;
  unitSize?: number;
  unit?: Uom;
  /**
   * Vocabulary for compound splitting, built from every title in this product
   * line. Without it, splitting is skipped — never guessed at.
   */
  vocabulary?: ReadonlySet<string>;
  /**
   * Brand names to recognise at the head of a title. Supplied by the caller
   * (pooled across a line) rather than held as a global list here.
   */
  knownBrands?: readonly string[];
}

/** Tokens that are never commercial identity, whatever the product. */
const STRUCTURAL_STOP = new Set([
  'the', 'a', 'of', 'and', 'with', 'in', 'for', 'to', 'by',
]);

function titleCase(text: string): string {
  return text.trim().toUpperCase();
}

/**
 * The brand at the head of a title.
 *
 * Prefers what the supplier stated. Otherwise matches a known brand as a
 * PREFIX — brand-leading is the near-universal convention in both EPOS exports
 * and supplier catalogues, and matching only at the head avoids claiming a
 * brand from the middle of a description.
 */
function detectBrand(
  tokens: readonly string[],
  opts: ParseOptions,
): { brand?: string; rest: string[] } {
  if (opts.brand) {
    // Strip the stated brand from the head if the title repeats it.
    const brandTokens = opts.brand.toLowerCase().split(/\s+/).filter(Boolean);
    const leads = brandTokens.every((token, index) => tokens[index] === token);
    return {
      brand: titleCase(opts.brand),
      rest: leads ? tokens.slice(brandTokens.length) : [...tokens],
    };
  }

  // Longest known brand that the title actually starts with.
  const known = [...(opts.knownBrands ?? [])]
    .map((brand) => brand.toLowerCase().split(/\s+/).filter(Boolean))
    .filter((brandTokens) => brandTokens.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const brandTokens of known) {
    if (brandTokens.every((token, index) => tokens[index] === token)) {
      return {
        brand: titleCase(brandTokens.join(' ')),
        rest: tokens.slice(brandTokens.length),
      };
    }
  }

  return { rest: [...tokens] };
}

/**
 * Parse a product title into structured commercial data.
 *
 * Normalization runs first — it already extracts prices, containers, forms,
 * multipacks, piece counts and supplier decorations into metadata, and that
 * metadata IS the structured data this parser needs. Rather than re-implement
 * any of it, the parser consumes it and adds the fields normalization does not
 * produce: brand, variant, and the product residual.
 */
export function parseProduct(title: string, opts: ParseOptions = {}): ParsedProduct {
  const normalized = normalizeProduct(
    title,
    opts.supplier ? { supplier: opts.supplier } : {},
  );
  const metadata = normalized.extractedMetadata;

  const removed: ParsedProduct['trace']['removed'] = [];
  const note = (field: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') {
      removed.push({ field, value: String(value) });
    }
  };
  note('price', metadata.priceText.join(', '));
  note('container', metadata.container);
  note('form', metadata.form);
  note('multipack', metadata.multipackCount);
  note('pieceCount', metadata.pieceCount);
  note('retailFlags', metadata.retailFlags.join(', '));
  note('decorations', metadata.decorations.join(', '));

  // Compound splitting, only when the caller supplied a vocabulary.
  let text = normalized.normalizedQuery;
  let compoundSplits: { from: string; to: string }[] = [];
  if (opts.vocabulary && opts.vocabulary.size > 0) {
    const result = splitCompounds(text, opts.vocabulary);
    text = result.text;
    compoundSplits = result.splits;
  }

  let tokens = text.split(/\s+/).filter((token) => token && !STRUCTURAL_STOP.has(token));

  // --- Brand ---------------------------------------------------------------
  const { brand, rest } = detectBrand(tokens, opts);
  tokens = rest;

  // --- Variant -------------------------------------------------------------
  // Formulation markers only. A flavour ("BLACK MINT") names WHICH product and
  // stays in `product`; a formulation names which VERSION and moves here.
  const variantTokens = tokens.filter((token) => FORMULATION_TOKENS.has(token));
  if (variantTokens.length > 0) {
    tokens = tokens.filter((token) => !FORMULATION_TOKENS.has(token));
  }

  // --- Product: the residual ----------------------------------------------
  const product = titleCase(tokens.join(' '));
  const variant = variantTokens.length > 0 ? titleCase(variantTokens.join(' ')) : undefined;

  // Identity is brand + core product ONLY. Everything else became a field.
  const canonicalIdentity = [brand, product].filter(Boolean).join(' ').trim();

  return {
    ...(brand ? { brand } : {}),
    product,
    ...(variant ? { variant } : {}),
    ...(metadata.form ? { form: metadata.form } : {}),
    ...(metadata.container ? { container: metadata.container } : {}),
    ...(metadata.multipackCount !== undefined ? { multipack: metadata.multipackCount } : {}),
    ...(metadata.pieceCount !== undefined ? { pieceCount: metadata.pieceCount } : {}),
    ...(opts.unitSize !== undefined ? { unitSize: opts.unitSize } : {}),
    ...(opts.unit ? { unit: opts.unit } : {}),
    ...(opts.caseQuantity !== undefined ? { caseQuantity: opts.caseQuantity } : {}),
    canonicalIdentity,
    trace: {
      original: title,
      normalized: normalized.normalizedQuery,
      compoundSplits,
      removed,
    },
  };
}

// ---- Field comparison ------------------------------------------------------

export type FieldVerdict = 'match' | 'differ' | 'unknown';

export interface FieldComparison {
  field: string;
  requested?: string | number;
  allocated?: string | number;
  verdict: FieldVerdict;
}

/**
 * Compare two parsed products field by field.
 *
 * Replaces string comparison with structured comparison: each field answers for
 * itself, and a field neither side states is `unknown` rather than a mismatch.
 *
 * Brand-scoped synonyms have already been applied during normalization, so
 * "ZERO" and "ZERO SUGAR" arrive here as the same canonical variant — the
 * equivalence is resolved before comparison, exactly as required.
 */
export function compareParsed(
  requested: ParsedProduct,
  allocated: ParsedProduct,
): FieldComparison[] {
  const compare = (
    field: string,
    left: string | number | undefined,
    right: string | number | undefined,
  ): FieldComparison => ({
    field,
    ...(left !== undefined ? { requested: left } : {}),
    ...(right !== undefined ? { allocated: right } : {}),
    verdict:
      left === undefined || right === undefined
        ? 'unknown'
        : String(left).toUpperCase() === String(right).toUpperCase()
          ? 'match'
          : 'differ',
  });

  return [
    compare('brand', requested.brand, allocated.brand),
    compare('product', requested.product || undefined, allocated.product || undefined),
    // Unstated variant means the base product, so absent compares as absent.
    compare('variant', requested.variant ?? 'NONE', allocated.variant ?? 'NONE'),
    compare('form', requested.form, allocated.form),
    compare('container', requested.container, allocated.container),
    compare('multipack', requested.multipack ?? 1, allocated.multipack ?? 1),
    compare('caseQuantity', requested.caseQuantity, allocated.caseQuantity),
    compare('unitSize', requested.unitSize, allocated.unitSize),
  ];
}

/** Vocabulary for compound splitting, built from a line's titles. */
export function vocabularyFor(titles: readonly string[]): Set<string> {
  const config = getConfig();
  const vocabulary = new Set<string>();

  for (const title of titles) {
    for (const token of title.toLowerCase().split(/[^a-z]+/)) {
      if (token.length >= 3) vocabulary.add(token);
    }
  }
  // Configured words are legitimate vocabulary too — they are real words that
  // happen to be filtered later, and a compound may be built from them.
  for (const word of [...config.productForms, ...config.containers]) {
    if (word.length >= 3) vocabulary.add(word);
  }

  return vocabulary;
}
