/**
 * Resolved product identity — the memory the matcher builds as it works.
 *
 * WRITES ARE BEST-EFFORT, READS ARE NOT ALLOWED TO LIE
 *
 * `rememberIdentity` never throws. It is bookkeeping alongside a match the
 * pipeline has already made, and losing one write costs a future shortcut, not
 * this line's answer.
 *
 * `resolveByDescription` is the opposite. It decides whether an upload skips
 * discovery entirely, so a failure must read as "no mapping" and never as a
 * mapping that happens to be wrong. It returns null on any doubt.
 *
 * WHAT IS DELIBERATELY NOT CACHED IN MEMORY
 *
 * Nothing. The lookup is one indexed primary-key read per line, and a process
 * cache would go stale exactly when an admin corrects a mapping — the one
 * moment being right matters most.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { createLogger } from '../log.js';

const log = createLogger('product-identity');

/** Mirrors `MatchProvenance` in types.ts. */
export type IdentityProvenance =
  | 'ean_exact'
  | 'invoice'
  | 'human_confirmed'
  | 'llm_suggested';

/**
 * Provenances the read path will act on.
 *
 * `llm_suggested` is excluded on purpose: it means "a candidate nobody
 * verified", and a mapping that skips discovery has to be one somebody or
 * something actually established.
 */
const TRUSTED: IdentityProvenance[] = ['ean_exact', 'invoice', 'human_confirmed'];

export interface IdentitySku {
  supplierId: string;
  supplierSku: string;
  provenance: IdentityProvenance;
  confidence: number;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: string;
}

export interface ResolvedIdentity {
  gtin14: string;
  name?: string;
  brand?: string;
  skus: IdentitySku[];
}

function toSku(record: Record<string, any>): IdentitySku {
  return {
    supplierId: String(record.supplier_id),
    supplierSku: String(record.supplier_sku),
    provenance: (record.provenance ?? 'ean_exact') as IdentityProvenance,
    confidence: Number(record.confidence ?? 1),
    ...(record.units_per_case != null ? { unitsPerCase: Number(record.units_per_case) } : {}),
    ...(record.unit_size != null ? { unitSize: Number(record.unit_size) } : {}),
    ...(record.uom ? { uom: String(record.uom) } : {}),
  };
}

/**
 * The mapping for an EPOS description, if one has been established.
 *
 * `normalizedQuery` must be the output of `canonicalQuery()` — the same string
 * the write path stored. Matching on the raw description would miss every time
 * the retailer re-exported with a different price suffix.
 *
 * Returns null when nothing is known, when only untrusted provenances exist, or
 * when the database could not be asked. All three mean the same thing to the
 * caller: carry on and search.
 */
export async function resolveByDescription(
  normalizedQuery: string,
): Promise<ResolvedIdentity | null> {
  const key = normalizedQuery.trim();
  if (!key) return null;

  try {
    const supabase = getSupabaseClient();

    const alias = await supabase
      .from('product_identity_aliases')
      .select('gtin14')
      .eq('normalized_query', key)
      .limit(1);

    if (alias.error) throw new Error(alias.error.message);
    const gtin14 = (alias.data?.[0] as Record<string, any> | undefined)?.gtin14;
    if (!gtin14) return null;

    const [identity, skus] = await Promise.all([
      supabase.from('product_identity').select('gtin14, name, brand').eq('gtin14', gtin14).limit(1),
      supabase
        .from('product_identity_skus')
        .select('supplier_id, supplier_sku, provenance, confidence, units_per_case, unit_size, uom')
        .eq('gtin14', gtin14)
        .in('provenance', TRUSTED),
    ]);

    if (identity.error) throw new Error(identity.error.message);
    if (skus.error) throw new Error(skus.error.message);

    const rows = (skus.data ?? []) as Record<string, any>[];
    // A mapping with no trusted supplier code cannot skip anything — there is
    // no code to ask a price for.
    if (rows.length === 0) return null;

    const head = (identity.data?.[0] ?? {}) as Record<string, any>;

    return {
      gtin14: String(gtin14),
      ...(head.name ? { name: String(head.name) } : {}),
      ...(head.brand ? { brand: String(head.brand) } : {}),
      skus: rows.map(toSku),
    };
  } catch (error) {
    log.warn('Identity lookup failed — falling back to search', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface RememberInput {
  gtin14: string;
  name?: string;
  brand?: string;
  /** The canonicalQuery() form of the description that resolved here. */
  normalizedQuery?: string;
  skus: {
    supplierId: string;
    supplierSku: string;
    provenance?: IdentityProvenance;
    confidence?: number;
    unitsPerCase?: number;
    unitSize?: number;
    uom?: string;
  }[];
}

/**
 * Record what a match established. Never throws.
 *
 * Writes the identity, then its supplier codes, then the alias — in that order
 * because the latter two reference the first. A partial write is survivable:
 * the read path requires all three, so a half-written mapping simply is not
 * found and the next upload rebuilds it.
 */
export async function rememberIdentity(input: RememberInput): Promise<void> {
  const gtin14 = input.gtin14?.trim();
  if (!gtin14 || input.skus.length === 0) return;

  try {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    const identity = await supabase.from('product_identity').upsert(
      {
        gtin14,
        ...(input.name ? { name: input.name } : {}),
        ...(input.brand ? { brand: input.brand } : {}),
      },
      { onConflict: 'gtin14' },
    );
    if (identity.error) throw new Error(identity.error.message);

    const skus = await supabase.from('product_identity_skus').upsert(
      input.skus.map((sku) => ({
        gtin14,
        supplier_id: sku.supplierId,
        supplier_sku: sku.supplierSku,
        provenance: sku.provenance ?? 'ean_exact',
        confidence: sku.confidence ?? 1,
        ...(sku.unitsPerCase !== undefined ? { units_per_case: sku.unitsPerCase } : {}),
        ...(sku.unitSize !== undefined ? { unit_size: sku.unitSize } : {}),
        ...(sku.uom ? { uom: sku.uom } : {}),
        last_seen_at: now,
      })),
      { onConflict: 'gtin14,supplier_id' },
    );
    if (skus.error) throw new Error(skus.error.message);

    const normalizedQuery = input.normalizedQuery?.trim();
    if (normalizedQuery) {
      // `hits` is not incremented here. Reading-then-writing to add one would
      // be a race between concurrent rows of the same upload, and the count is
      // advisory — nothing decides on it today. Re-resolving simply refreshes
      // last_seen_at.
      const alias = await supabase.from('product_identity_aliases').upsert(
        { normalized_query: normalizedQuery, gtin14, last_seen_at: now },
        { onConflict: 'normalized_query' },
      );
      if (alias.error) throw new Error(alias.error.message);
    }
  } catch (error) {
    log.warn('Could not record product identity', {
      gtin14,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
