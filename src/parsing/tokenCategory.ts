/**
 * Token categories — every token belongs to exactly ONE.
 *
 * The invariant this file enforces:
 *
 *   A token's category is a property of the TOKEN, never of the product it
 *   appears in. "CHOCOLATE" is a product descriptor in every product that has
 *   ever contained it. "GUM" is a commercial form everywhere. "ZERO" is a
 *   variant everywhere. "PACK" is packaging everywhere.
 *
 * Why this matters more than it looks
 * -----------------------------------
 * The previous design let a token mean different things in different products —
 * "cola" was deleted as noise for Pepsi but kept as identity for Coca-Cola. That
 * is unfalsifiable by construction: any bad match can be "fixed" by recategorising
 * a word for one product, and the configuration grows forever while the model of
 * the domain gets less true. Pinning each token to one category makes a wrong
 * categorisation a bug that shows up everywhere at once, which is what makes it
 * fixable.
 *
 * The categories
 * --------------
 *   brand       manufacturer or range owner
 *   variant     formulation: zero, diet, sugarfree, dark, white
 *   form        commercial form: gum, bar, lozenges, sweets
 *   container   packaging vessel: bottle, can, jar, box
 *   packaging   packaging quantity: pack, case, piece counts
 *   decoration  retailer/supplier catalogue noise ONLY: std, promo, new
 *   descriptor  everything else — flavours, ingredients, sub-ranges. The
 *               DEFAULT. Nothing needs configuring to land here.
 *
 * `descriptor` being the default is what stops configuration growing: an
 * unrecognised word is product identity, which is the safe assumption.
 */

import { getConfig } from '../normalization/config.js';
import { FORMULATION_TOKENS } from '../services/matchConfidence.js';
import { createLogger } from '../log.js';

const log = createLogger('token-category');

export type TokenCategory =
  | 'brand'
  | 'variant'
  | 'form'
  | 'container'
  | 'packaging'
  | 'decoration'
  | 'descriptor';

/**
 * Packaging quantity words. Structural and closed — these describe how many or
 * how something is grouped, never what it is.
 */
const PACKAGING_TOKENS = new Set([
  'pack', 'packs', 'pk', 'packet', 'packets', 'case', 'cases', 'cs',
  'outer', 'inner', 'bundle', 'bundles', 'piece', 'pieces', 'pce', 'pcs', 'pc',
  'each', 'ea', 'single', 'singles', 'multipack',
  // 'pmp' and 'pm' are deliberately NOT here. A price-marked pack is a retailer
  // PRICE MARKING, not a packaging quantity — it says how the line is sold, not
  // how the product is grouped. They belong to `decoration`, and a token cannot
  // hold two categories.
]);

export interface CategoryConflict {
  token: string;
  categories: TokenCategory[];
}

interface Registry {
  categories: Map<string, TokenCategory>;
  conflicts: CategoryConflict[];
}

let cached: Registry | null = null;

function build(): Registry {
  const config = getConfig();
  const categories = new Map<string, TokenCategory>();
  const seen = new Map<string, TokenCategory[]>();

  const assign = (tokens: Iterable<string>, category: TokenCategory) => {
    for (const raw of tokens) {
      const token = raw.trim().toLowerCase();
      if (!token || token.startsWith('$')) continue;
      const existing = seen.get(token) ?? [];
      if (!existing.includes(category)) existing.push(category);
      seen.set(token, existing);
      // First assignment wins; conflicts are reported below.
      if (!categories.has(token)) categories.set(token, category);
    }
  };

  // Order is significance, not precedence: a token in two of these lists is a
  // configuration bug, reported rather than silently resolved.
  assign(FORMULATION_TOKENS, 'variant');
  assign(config.productForms, 'form');
  assign(config.containers, 'container');
  assign(PACKAGING_TOKENS, 'packaging');
  assign(config.countableNoise, 'packaging');
  assign(config.retailNoise, 'decoration');
  for (const words of Object.values(config.decorations)) assign(words, 'decoration');

  const conflicts: CategoryConflict[] = [...seen.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([token, list]) => ({ token, categories: list }));

  if (conflicts.length > 0) {
    log.warn('Tokens assigned to more than one category — every token must have exactly one', {
      conflicts: conflicts.map((c) => `${c.token}: ${c.categories.join('/')}`).join('; '),
    });
  }

  return { categories, conflicts };
}

function registry(): Registry {
  if (!cached) cached = build();
  return cached;
}

export function resetTokenCategories(): void {
  cached = null;
}

/**
 * The category of one token.
 *
 * `descriptor` is the default: an unrecognised word is product identity. That
 * is deliberately the safe assumption — treating an unknown word as noise would
 * quietly merge products nobody has configured yet.
 */
export function categoryOf(token: string): TokenCategory {
  return registry().categories.get(token.trim().toLowerCase()) ?? 'descriptor';
}

/** Tokens configured into more than one category. Empty means the config is sound. */
export function categoryConflicts(): CategoryConflict[] {
  return registry().conflicts;
}

/** Every token currently assigned a non-default category, for the debug report. */
export function categorise(text: string): { token: string; category: TokenCategory }[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .filter(Boolean)
    .map((token) => ({ token, category: categoryOf(token) }));
}
