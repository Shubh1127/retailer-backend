/**
 * Exact-barcode lookup against the LOCAL catalogues.
 *
 * No supplier requests. Both sides are already synced into Supabase and both
 * are indexed on their barcode, so "does the other supplier stock this exact
 * product" is a primary-key-shaped question answered in milliseconds — which is
 * the whole reason cross-supplier EAN matching is affordable per line.
 *
 * WHY THE TWO SUPPLIERS ARE QUERIED DIFFERENTLY
 *
 * They store barcodes differently, and pretending otherwise is how a lookup
 * silently returns nothing:
 *
 *   Musgrave   `gtin14` is canonical, written by the backfill and the sync.
 *              A direct equality match, plus `additional_gtins` as a fallback.
 *
 *   O'Reilly   `ean` is verbatim from the product page and un-normalised, so
 *              the same product can be stored as 12, 13 or 14 digits. The
 *              canonical form is expanded into the spellings it could have been
 *              written as and matched with IN, which still uses the index.
 *
 * ONE CANONICAL FORM CROSSES THE BOUNDARY
 *
 * Every function here takes and returns GTIN-14 as produced by
 * `normalizeToGtin14`. A caller holding a raw barcode normalises first; a
 * caller comparing two barcodes compares canonical forms. Nothing in this
 * module compares raw strings, because "5018420311434" and "05018420311434"
 * are the same product and differ as text.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { GtinError, normalizeToGtin14 } from '../gtin.js';
import { toExVat } from '../pricing/normalize.js';
import { parseSizeText } from '../connectors/types.js';
import { absoluteUrl } from '../connectors/types.js';
import type { RuleCandidate } from './ruleEngine.js';
import { createLogger } from '../log.js';

const log = createLogger('ean-lookup');

/** Image host, mirroring `musgrave.service.ts`. Product pages are on www. */
const MUSGRAVE_IMAGE_BASE = 'https://www-api.musgravemarketplace.ie';

/**
 * Canonicalise a barcode, or return nothing.
 *
 * The one gate between "a supplier printed some digits" and "this is an
 * identity". An invalid check digit or a restricted variable-weight prefix
 * yields `undefined`, so an unusable barcode can never become a lookup key.
 */
export function canonicalGtin(value: string | undefined | null): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    return normalizeToGtin14(raw);
  } catch (error) {
    if (error instanceof GtinError) return undefined;
    throw error;
  }
}

/**
 * The spellings a canonical GTIN-14 may have been stored as.
 *
 * GTIN-14 is the zero-padded superset of EAN-8, UPC-12 and EAN-13, so a
 * catalogue holding the barcode verbatim could have any of them. Stripping the
 * padding and re-padding to each valid width covers every form without a
 * wildcard, which matters because a LIKE would not use the index.
 */
export function gtinSpellings(gtin14: string): string[] {
  const significant = gtin14.replace(/^0+/, '');
  const spellings = new Set<string>([gtin14]);

  for (const width of [8, 12, 13, 14]) {
    if (significant.length <= width) {
      spellings.add(significant.padStart(width, '0'));
    }
  }

  return [...spellings];
}

/** A product found by exact barcode, with where it was found and how. */
export interface EanHit {
  supplier: 'musgrave' | 'oreilly';
  gtin14: string;
  /**
   * Identity and metadata ONLY — deliberately carries no `exVatCasePrice`.
   *
   * These rows come from the synced catalogue, whose price is as old as the
   * last sync. Letting one into the candidate list would put a stale number in
   * front of `chooseBestSupplier` alongside live prices from the other
   * supplier, and it could win the line on a figure nobody re-checked.
   *
   * The omission is structural rather than a rule to remember: the field is
   * simply never set, so there is no stored price for a later change to leak by
   * accident. A discovered SKU is re-priced through live supplier search before
   * it can be selected — see `repriceDiscovered` in the dashboard pipeline.
   */
  candidate: RuleCandidate;
  /**
   * What the catalogue row said, for diagnostics only.
   *
   * Kept apart from the candidate on purpose. Nothing in selection or
   * allocation reads it, and nothing should: it exists so a stale-looking
   * comparison can be explained after the fact, not so it can be used.
   */
  cataloguePrice?: number;
  /**
   * 'primary'    the supplier's own retail barcode matched.
   * 'additional' it matched one of the alternates in `AdditionalEAN`.
   *
   * Kept apart because an alternate is a weaker claim: those lists carry outer
   * case codes and internal references alongside genuine alternates, so a hit
   * on one is evidence, not proof.
   */
  via: 'primary' | 'additional';
}

// ---------------------------------------------------------------------------
// Musgrave
// ---------------------------------------------------------------------------

interface MusgraveRow {
  sku: string;
  name: string | null;
  manufacturer: string | null;
  size: string | null;
  image: string | null;
  sale_price: number | null;
  tax_rate: number | null;
  gtin14: string | null;
  additional_gtins: string[] | null;
}

const MUSGRAVE_COLUMNS =
  'sku, name, manufacturer, size, image, sale_price, tax_rate, gtin14, additional_gtins';

function musgraveCandidate(row: MusgraveRow): {
  candidate: RuleCandidate;
  cataloguePrice?: number;
} {
  const pack = parseSizeText(row.size ?? '');
  // `parseSizeText` answers 1x1 "each" when it could not read the text at all.
  // That is a parse failure wearing a real-looking value, and passing it on
  // would tell the rules a pack was verified when nothing was.
  const packKnown = !(pack.unitsPerCase === 1 && pack.unitSize === 1 && pack.uom === 'each');

  // Musgrave sale prices are ex-VAT already; `toExVat` is applied for the same
  // reason the live search applies it, so one supplier cannot arrive inclusive.
  const exVat =
    row.sale_price != null
      ? toExVat(Number(row.sale_price), Number(row.tax_rate ?? 0), false)
      : undefined;

  return {
    // NOTE the absent `exVatCasePrice` — see `EanHit.candidate`.
    candidate: {
      supplier: 'musgrave',
      name: row.name ?? '',
      ...(row.manufacturer ? { brand: row.manufacturer } : {}),
      ...(row.gtin14 ? { ean: row.gtin14 } : {}),
      sku: row.sku,
      ...(packKnown
        ? { unitsPerCase: pack.unitsPerCase, unitSize: pack.unitSize, uom: pack.uom }
        : {}),
      ...(absoluteUrl(row.image ?? undefined, MUSGRAVE_IMAGE_BASE)
        ? { imageUrl: absoluteUrl(row.image ?? undefined, MUSGRAVE_IMAGE_BASE)! }
        : {}),
    },
    ...(exVat !== undefined && Number.isFinite(exVat) ? { cataloguePrice: exVat } : {}),
  };
}

/**
 * Musgrave products carrying this exact barcode.
 *
 * Primary first. The alternates are only consulted when the primary found
 * nothing, so a product whose retail barcode matches is never outranked by
 * another product that merely lists the same code among its alternates.
 */
export async function findMusgraveByGtin(gtin14: string): Promise<EanHit[]> {
  const supabase = getSupabaseClient();

  const primary = await supabase
    .from('musgrave_products')
    .select(MUSGRAVE_COLUMNS)
    .eq('gtin14', gtin14)
    .limit(10);

  if (primary.error) {
    log.warn('Musgrave primary barcode lookup failed', { message: primary.error.message });
    return [];
  }

  if (primary.data && primary.data.length > 0) {
    return (primary.data as unknown as MusgraveRow[]).map((row) => ({
      supplier: 'musgrave' as const,
      gtin14,
      ...musgraveCandidate(row),
      via: 'primary' as const,
    }));
  }

  const alternates = await supabase
    .from('musgrave_products')
    .select(MUSGRAVE_COLUMNS)
    .contains('additional_gtins', [gtin14])
    .limit(10);

  if (alternates.error) {
    log.warn('Musgrave alternate barcode lookup failed', { message: alternates.error.message });
    return [];
  }

  return (alternates.data ?? []).map((row) => ({
    supplier: 'musgrave' as const,
    gtin14,
    ...musgraveCandidate(row as unknown as MusgraveRow),
    via: 'additional' as const,
  }));
}

// ---------------------------------------------------------------------------
// O'Reilly
// ---------------------------------------------------------------------------

interface OreillyRow {
  product_code: string;
  name: string | null;
  ean: string | null;
  size_text: string | null;
  units_per_case: number | null;
  unit_size: number | null;
  uom: string | null;
  /** Trade price per case, already ex-VAT — see the column comment. */
  price: number | null;
  image_url: string | null;
}

const OREILLY_COLUMNS =
  'product_code, name, ean, size_text, units_per_case, unit_size, uom, price, image_url';

function oreillyCandidate(
  row: OreillyRow,
  gtin14: string,
): { candidate: RuleCandidate; cataloguePrice?: number } {
  const fromText = parseSizeText(row.size_text ?? '');
  const unitsPerCase = row.units_per_case ?? undefined;
  const unitSize = row.unit_size ?? undefined;

  // Structured columns beat the parsed text — O'Reilly publishes Pack Qty and
  // Size as separate fields, and re-deriving them from a combined string only
  // adds a way to be wrong.
  const pack =
    unitsPerCase !== undefined && unitSize !== undefined
      ? { unitsPerCase, unitSize, uom: (row.uom ?? 'each') as RuleCandidate['uom'] }
      : fromText.unitsPerCase === 1 && fromText.unitSize === 1 && fromText.uom === 'each'
        ? undefined
        : fromText;

  return {
    // NOTE the absent `exVatCasePrice` — see `EanHit.candidate`.
    candidate: {
      supplier: 'oreilly',
      name: row.name ?? '',
      ean: gtin14,
      sku: row.product_code,
      ...(pack ? { unitsPerCase: pack.unitsPerCase, unitSize: pack.unitSize, uom: pack.uom } : {}),
      ...(row.image_url ? { imageUrl: row.image_url } : {}),
    },
    ...(row.price != null && Number.isFinite(Number(row.price))
      ? { cataloguePrice: Number(row.price) }
      : {}),
  };
}

/** O'Reilly products carrying this exact barcode, in any spelling. */
export async function findOreillyByGtin(gtin14: string): Promise<EanHit[]> {
  const { data, error } = await getSupabaseClient()
    .from('oreilly_products')
    .select(OREILLY_COLUMNS)
    .in('ean', gtinSpellings(gtin14))
    .limit(10);

  if (error) {
    log.warn("O'Reilly barcode lookup failed", { message: error.message });
    return [];
  }

  return (data ?? []).map((row) => ({
    supplier: 'oreilly' as const,
    gtin14,
    ...oreillyCandidate(row as unknown as OreillyRow, gtin14),
    via: 'primary' as const,
  }));
}

// ---------------------------------------------------------------------------
// Both
// ---------------------------------------------------------------------------

/**
 * Look this barcode up at a supplier. Never throws: a lookup that cannot run is
 * a lookup that found nothing, and the text pipeline still has its own answer.
 */
export async function findByGtin(
  supplier: 'musgrave' | 'oreilly',
  gtin14: string,
): Promise<EanHit[]> {
  try {
    return supplier === 'musgrave'
      ? await findMusgraveByGtin(gtin14)
      : await findOreillyByGtin(gtin14);
  } catch (error) {
    log.warn('Barcode lookup failed', {
      supplier,
      gtin14,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Look several barcodes up at one supplier, de-duplicated by SKU.
 *
 * Concurrent because each is an independent indexed read and the ladder above
 * is already waiting on the slowest one. Bounded by the caller passing only the
 * top few candidates' barcodes — this is not a batch API.
 */
export async function findAllByGtins(
  supplier: 'musgrave' | 'oreilly',
  gtins: readonly string[],
): Promise<EanHit[]> {
  const unique = [...new Set(gtins)];
  if (unique.length === 0) return [];

  const results = await Promise.all(unique.map((gtin) => findByGtin(supplier, gtin)));

  const bySku = new Map<string, EanHit>();
  for (const hit of results.flat()) {
    const key = `${hit.supplier}:${hit.candidate.sku ?? hit.candidate.name}`;
    const existing = bySku.get(key);
    // A primary hit outranks an alternate hit for the same product.
    if (!existing || (existing.via === 'additional' && hit.via === 'primary')) {
      bySku.set(key, hit);
    }
  }

  return [...bySku.values()];
}
