/**
 * Normalization configuration — loading and shape.
 *
 * Everything that names a product lives in `config/normalization.json`, never
 * in code. That is the whole design constraint: the pipeline improves by growing
 * a dictionary, not by growing branches. Nothing in `src/` should ever contain
 * a product name, a brand, or a supplier's phrasing.
 *
 * The file is read once and cached. `NORMALIZATION_CONFIG_PATH` overrides the
 * location so a deployment can ship its own dictionary, and `setConfig` lets a
 * test supply one inline without touching the disk.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../log.js';

const log = createLogger('normalization-config');

export interface NormalizationConfig {
  /** Retail shorthand → full word. Applied before anything else reads the text. */
  abbreviations: Record<string, string>;
  /** Multi-word equivalences → canonical form. Applied longest phrase first. */
  synonyms: Record<string, string>;
  /**
   * Equivalences that hold only inside one brand's range, keyed by brand. The
   * brand's map applies when its key appears as whole words in the text.
   */
  brandSynonyms: Record<string, Record<string, string>>;
  /** Retailer-only decorations ("CASE", "PMP") — removed, kept as metadata. */
  retailNoise: string[];
  /** Packaging nouns removed only when NOT preceded by a count ("PACK" vs "4 PACK"). */
  countableNoise: string[];
  /** Physical product form ("gum", "roll") — extracted to metadata, compared separately. */
  productForms: string[];
  /** Regexes capturing a piece/unit count ("46P", "10 PCE"). */
  pieceCountPatterns: string[];
  /** Regexes capturing a multipack count ("10 PACK", "4PK"). */
  multipackPatterns: string[];
  /** Regexes capturing alcohol by volume ("0.0%", "4.2% ABV"). */
  abvPatterns: string[];
  /** Physical packaging — removed from the query, kept as metadata. */
  containers: string[];
  /** Supplier catalogue decoration. '*' applies to every supplier. */
  decorations: Record<string, string[]>;
  /** Regexes matching an embedded shelf/promo price. */
  pricePatterns: string[];
}

const EMPTY: NormalizationConfig = {
  abbreviations: {},
  synonyms: {},
  brandSynonyms: {},
  retailNoise: [],
  countableNoise: [],
  productForms: [],
  pieceCountPatterns: [],
  multipackPatterns: [],
  abvPatterns: [],
  containers: [],
  decorations: {},
  pricePatterns: [],
};

/**
 * Drop any rewrite whose replacement contains its own key as a whole word.
 *
 * "zero" → "zero sugar" would match itself in its own output and grow on every
 * pass. Rejecting it at load time turns a silent runaway into one warning, and
 * keeps a bad dictionary entry from becoming a production incident.
 */
function rejectSelfReferential(
  map: Record<string, string>,
  scope: string,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [phrase, canonical] of Object.entries(map)) {
    const selfMatch = new RegExp(`(?<![a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
    if (phrase !== canonical && selfMatch.test(canonical)) {
      log.warn('Ignoring self-referential synonym', { scope, phrase, canonical });
      continue;
    }
    safe[phrase] = canonical;
  }
  return safe;
}

function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/normalization → backend/config
  return join(here, '..', '..', 'config', 'normalization.json');
}

let cached: NormalizationConfig | null = null;

/** Strip the `$comment*` documentation keys the JSON file carries. */
function stripComments(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !key.startsWith('$comment')),
  );
}

function lowerKeys(record: Record<string, string> | undefined): Record<string, string> {
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.trim().toLowerCase(),
      value.trim().toLowerCase(),
    ]),
  );
}

function lowerList(list: string[] | undefined): string[] {
  return (list ?? [])
    .map((entry) => entry.trim().toLowerCase())
    // `$note:` entries document a list inline; they are prose, not words.
    .filter((entry) => entry && !entry.startsWith('$'));
}

/**
 * The active configuration.
 *
 * A missing or malformed file is NOT fatal: normalization degrades to "expand
 * nothing, strip nothing", which is exactly the behaviour before this layer
 * existed. A dictionary problem must never stop a retailer processing an order.
 */
export function getConfig(): NormalizationConfig {
  if (cached) return cached;

  const path = resolve(process.env.NORMALIZATION_CONFIG_PATH ?? defaultConfigPath());

  try {
    const raw = stripComments(JSON.parse(readFileSync(path, 'utf8')));

    cached = {
      abbreviations: lowerKeys(raw.abbreviations as Record<string, string>),
      synonyms: rejectSelfReferential(
        lowerKeys(raw.synonyms as Record<string, string>),
        'synonyms',
      ),
      brandSynonyms: Object.fromEntries(
        Object.entries((raw.brandSynonyms as Record<string, Record<string, string>>) ?? {}).map(
          ([brand, map]) => [
            brand.trim().toLowerCase(),
            rejectSelfReferential(lowerKeys(map), `brandSynonyms.${brand}`),
          ],
        ),
      ),
      retailNoise: lowerList(raw.retailNoise as string[]),
      countableNoise: lowerList(raw.countableNoise as string[]),
      productForms: lowerList(raw.productForms as string[]),
      pieceCountPatterns: (raw.pieceCountPatterns as string[]) ?? [],
      multipackPatterns: (raw.multipackPatterns as string[]) ?? [],
      abvPatterns: (raw.abvPatterns as string[]) ?? [],
      containers: lowerList(raw.containers as string[]),
      decorations: Object.fromEntries(
        Object.entries((raw.decorations as Record<string, string[]>) ?? {}).map(
          ([supplier, words]) => [supplier.trim().toLowerCase(), lowerList(words)],
        ),
      ),
      pricePatterns: (raw.pricePatterns as string[]) ?? [],
    };

    log.debug('Normalization config loaded', {
      path,
      abbreviations: Object.keys(cached.abbreviations).length,
      synonyms: Object.keys(cached.synonyms).length,
      decorations: Object.keys(cached.decorations).length,
    });

    return cached;
  } catch (error) {
    log.warn('Normalization config unavailable — running without normalization', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    cached = EMPTY;
    return cached;
  }
}

/**
 * Replace the active configuration (tests, or a runtime reload).
 *
 * The self-referential guard runs here too: a rewrite that matches its own
 * output loops regardless of whether it came from the file or from code, so
 * validating in only one path would leave the other able to hang the pipeline.
 */
export function setConfig(config: Partial<NormalizationConfig>): void {
  const merged = { ...EMPTY, ...getConfig(), ...config };
  cached = {
    ...merged,
    synonyms: rejectSelfReferential(merged.synonyms, 'synonyms'),
    brandSynonyms: Object.fromEntries(
      Object.entries(merged.brandSynonyms).map(([brand, map]) => [
        brand,
        rejectSelfReferential(map, `brandSynonyms.${brand}`),
      ]),
    ),
  };
}

/** Drop the cache so the next read re-reads the file. */
export function resetConfig(): void {
  cached = null;
}

/** Decoration words that apply to `supplier`, including the global set. */
export function decorationsFor(supplier: string | undefined): Set<string> {
  const config = getConfig();
  return new Set([
    ...(config.decorations['*'] ?? []),
    ...(supplier ? (config.decorations[supplier.toLowerCase()] ?? []) : []),
  ]);
}
