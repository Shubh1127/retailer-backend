/**
 * Admin override persistence.
 *
 * Two tables, two lifetimes — see the migration for why. In short:
 * `job_row_overrides` records what an admin did to one line of one upload;
 * `product_overrides` records what a description MEANS, and is consulted on
 * every future run so the same correction is never made twice.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { normalizedIdentity } from '../normalization/productNormalization.js';
import { createLogger } from '../log.js';

const log = createLogger('admin:overrides');

export type OverrideAction = 'confirmed' | 'removed';

export interface JobRowOverride {
  jobId: string;
  rowNumber: number;
  action: OverrideAction;
  supplier?: string;
  supplierSku?: string;
  supplierProduct?: string;
  /**
   * Ex-VAT case price as the admin saw it. Display only — the supplier basket
   * quotes what is actually charged at order time.
   */
  priceExVat?: number;
  /**
   * The rest of the product the admin chose.
   *
   * Stored rather than looked up later for the same reason `processed_products`
   * stores its offers: this is a record of a decision and must keep saying what
   * was decided. A lookup at read time would answer with today's catalogue and
   * quietly rewrite what the admin is on record as approving.
   *
   * Without these a confirmed line reached the retailer's table with a name and
   * nothing else, beside matched lines carrying an image, a pack and a price.
   */
  ean?: string;
  imageUrl?: string;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: string;
  reason?: string;
  createdByEmail?: string;
  createdAt?: string;
}

export interface ProductOverride {
  normalizedQuery: string;
  rawQuery?: string;
  supplier: string;
  supplierSku: string;
  supplierProduct?: string;
  ean?: string;
  createdByEmail?: string;
  note?: string;
}

/**
 * The key a description is remembered under.
 *
 * Normalized, so "WRIGLEYS EXTRA SPEARMENT 10PK €2.20" and "WRIGLEYS EXTRA
 * SPEARMENT 10PK" resolve to the same override — the price mark is not part of
 * what the line means. Exported so the read path and the write path cannot
 * disagree about it, which is the only way this table stays useful.
 */
export function overrideKey(description: string): string {
  return normalizedIdentity(description).trim().toUpperCase();
}

/** Record what an admin did to one line. Re-deciding replaces the decision. */
export async function saveJobRowOverride(override: JobRowOverride): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from('job_row_overrides').upsert(
    {
      job_id: override.jobId,
      row_number: override.rowNumber,
      action: override.action,
      supplier: override.supplier ?? null,
      supplier_sku: override.supplierSku ?? null,
      supplier_product: override.supplierProduct ?? null,
      price_ex_vat: override.priceExVat ?? null,
      ean: override.ean ?? null,
      image_url: override.imageUrl ?? null,
      units_per_case: override.unitsPerCase ?? null,
      unit_size: override.unitSize ?? null,
      uom: override.uom ?? null,
      reason: override.reason ?? null,
      created_by_email: override.createdByEmail ?? null,
    },
    { onConflict: 'job_id,row_number' },
  );

  if (error) {
    throw new Error(`Could not save the row override: ${error.message}`);
  }

  log.info('Row override saved', {
    jobId: override.jobId,
    row: override.rowNumber,
    action: override.action,
    by: override.createdByEmail,
  });
}

/** Every standing decision for one job, keyed by row number. */
export async function loadJobRowOverrides(
  jobId: string,
): Promise<Record<number, JobRowOverride>> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('job_row_overrides')
    .select('*')
    .eq('job_id', jobId);

  if (error) {
    throw new Error(`Could not read row overrides: ${error.message}`);
  }

  const byRow: Record<number, JobRowOverride> = {};

  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const rowNumber = Number(raw.row_number);
    if (!Number.isFinite(rowNumber)) continue;
    byRow[rowNumber] = {
      jobId,
      rowNumber,
      action: String(raw.action) as OverrideAction,
      ...(raw.supplier ? { supplier: String(raw.supplier) } : {}),
      ...(raw.supplier_sku ? { supplierSku: String(raw.supplier_sku) } : {}),
      ...(raw.supplier_product ? { supplierProduct: String(raw.supplier_product) } : {}),
      ...(raw.price_ex_vat != null ? { priceExVat: Number(raw.price_ex_vat) } : {}),
      ...(raw.ean ? { ean: String(raw.ean) } : {}),
      ...(raw.image_url ? { imageUrl: String(raw.image_url) } : {}),
      ...(raw.units_per_case != null ? { unitsPerCase: Number(raw.units_per_case) } : {}),
      ...(raw.unit_size != null ? { unitSize: Number(raw.unit_size) } : {}),
      ...(raw.uom ? { uom: String(raw.uom) } : {}),
      ...(raw.reason ? { reason: String(raw.reason) } : {}),
      ...(raw.created_by_email ? { createdByEmail: String(raw.created_by_email) } : {}),
      ...(raw.created_at ? { createdAt: String(raw.created_at) } : {}),
    };
  }

  return byRow;
}

/** Drop a standing decision, returning the line to whatever the pipeline said. */
export async function clearJobRowOverride(
  jobId: string,
  rowNumber: number,
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('job_row_overrides')
    .delete()
    .eq('job_id', jobId)
    .eq('row_number', rowNumber);

  if (error) {
    throw new Error(`Could not clear the row override: ${error.message}`);
  }
}

/**
 * Forget that a description means a particular supplier product.
 *
 * THE OTHER HALF OF AN UNDO.
 *
 * Confirming writes twice: the line's own decision, and the durable lesson that
 * this description means this product. Undoing only the first leaves the lesson
 * standing — so the line reverts, the admin sees it revert, and every future
 * file still matches the wrong product, taught by a decision that was already
 * taken back. That is worse than not offering an undo at all.
 *
 * Scoped to the supplier and SKU this confirmation actually taught. If somebody
 * has since confirmed the same description against a DIFFERENT product, that is
 * a newer decision and must survive — an undo reaches back to its own mistake,
 * not to whatever currently happens to be there.
 */
export async function clearProductOverride(
  normalizedQuery: string,
  supplier: string,
  supplierSku: string,
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('product_overrides')
    .delete()
    .eq('normalized_query', normalizedQuery)
    .eq('supplier', supplier)
    .eq('supplier_sku', supplierSku);

  if (error) {
    throw new Error(`Could not clear the product override: ${error.message}`);
  }

  // The matcher reads these from a cache; without this the forgotten mapping
  // keeps being applied until it happens to expire.
  forgetOverrideCache();
}

/**
 * Remember that a description means a particular supplier product.
 *
 * This is the durable half. Re-confirming the same description updates the row
 * rather than adding one, so the newest human decision is always the one a
 * future run reads.
 */
export async function saveProductOverride(override: ProductOverride): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from('product_overrides').upsert(
    {
      normalized_query: override.normalizedQuery,
      raw_query: override.rawQuery ?? null,
      supplier: override.supplier,
      supplier_sku: override.supplierSku,
      supplier_product: override.supplierProduct ?? null,
      ean: override.ean ?? null,
      created_by_email: override.createdByEmail ?? null,
      note: override.note ?? null,
    },
    { onConflict: 'normalized_query,supplier' },
  );

  if (error) {
    throw new Error(`Could not save the product override: ${error.message}`);
  }

  // A confirmation the pipeline cannot see for another minute is a confirmation
  // an admin will make twice.
  forgetOverrideCache();

  log.info('Product override saved', {
    query: override.normalizedQuery,
    supplier: override.supplier,
    sku: override.supplierSku,
  });
}

/**
 * Every override, keyed by normalized description.
 *
 * Loaded ONCE per run and cached, because the pipeline asks per order line: a
 * 213-line file would otherwise make 213 round trips to answer a question whose
 * answer barely changes. The table is small — one row per description a human
 * has ever corrected — so holding it whole costs nothing.
 *
 * The TTL is what stops a long-running server from ignoring an override an
 * admin made a moment ago. Sixty seconds is short enough that a correction is
 * live before anyone re-uploads, and long enough that a batch run reads it once.
 */
const CACHE_TTL_MS = 60_000;

let cache: { byQuery: Map<string, ProductOverride[]>; expiresAt: number } | null = null;

export function forgetOverrideCache(): void {
  cache = null;
}

export async function loadAllProductOverrides(): Promise<
  Map<string, ProductOverride[]>
> {
  if (cache && cache.expiresAt > Date.now()) return cache.byQuery;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('product_overrides').select('*');

  if (error) {
    throw new Error(`Could not read product overrides: ${error.message}`);
  }

  const byQuery = new Map<string, ProductOverride[]>();

  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const key = String(raw.normalized_query ?? '');
    if (!key) continue;
    const list = byQuery.get(key) ?? [];
    list.push({
      normalizedQuery: key,
      ...(raw.raw_query ? { rawQuery: String(raw.raw_query) } : {}),
      supplier: String(raw.supplier),
      supplierSku: String(raw.supplier_sku),
      ...(raw.supplier_product ? { supplierProduct: String(raw.supplier_product) } : {}),
      ...(raw.ean ? { ean: String(raw.ean) } : {}),
      ...(raw.created_by_email ? { createdByEmail: String(raw.created_by_email) } : {}),
      ...(raw.note ? { note: String(raw.note) } : {}),
    });
    byQuery.set(key, list);
  }

  cache = { byQuery, expiresAt: Date.now() + CACHE_TTL_MS };
  return byQuery;
}

/** Any standing override for this description, across suppliers. */
export async function loadProductOverrides(
  description: string,
): Promise<ProductOverride[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('product_overrides')
    .select('*')
    .eq('normalized_query', overrideKey(description));

  if (error) {
    throw new Error(`Could not read product overrides: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((raw) => ({
    normalizedQuery: String(raw.normalized_query),
    ...(raw.raw_query ? { rawQuery: String(raw.raw_query) } : {}),
    supplier: String(raw.supplier),
    supplierSku: String(raw.supplier_sku),
    ...(raw.supplier_product ? { supplierProduct: String(raw.supplier_product) } : {}),
    ...(raw.ean ? { ean: String(raw.ean) } : {}),
    ...(raw.created_by_email ? { createdByEmail: String(raw.created_by_email) } : {}),
    ...(raw.note ? { note: String(raw.note) } : {}),
  }));
}
