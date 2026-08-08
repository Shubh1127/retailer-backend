/**
 * Musgrave product persistence.
 *
 * Mirrors the category repository: the singleton Supabase client, one RPC as the
 * write path, and no SQL anywhere else.
 *
 * Products are applied a PAGE at a time rather than in one transaction like
 * categories. The catalogue is far larger than the category tree — a single
 * category can hold thousands of SKUs — so page-level atomicity is the right
 * granularity: a failure costs one page, not the whole run.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { createLogger } from '../log.js';
import type { ParsedProduct } from '../services/musgraveProducts.parse.js';

const log = createLogger('musgrave:products:repo');

export interface ProductUpsertResult {
  seen: number;
  inserted: number;
  updated: number;
  /** Rows whose tracked fields matched — no write performed. */
  unchanged: number;
}

export interface ProductUpsertContext {
  categoryId: number;
  categoryRef: string;
  syncRunId: number;
}

export type ProductSyncStatus = 'success' | 'partial' | 'failed';

export interface ProductSyncCounts {
  categoriesTotal: number;
  categoriesProcessed: number;
  categoriesFailed: number;
  pagesFetched: number;
  productsSeen: number;
  productsInserted: number;
  productsUpdated: number;
  productsUnchanged: number;
}

/** PostgREST caps a response at 1000 rows; catalogue reads page through. */
const READ_PAGE_SIZE = 1000;

/**
 * The subset of a product row needed to match an order line against the local
 * catalogue. Deliberately excludes `raw_product` — it is several KB per row and
 * the catalogue runs to tens of thousands of products.
 */
export interface CatalogueProductRow {
  sku: string;
  name: string;
  size?: string;
  manufacturer?: string;
  salePrice?: number;
  salePriceCurrency?: string;
  taxRate?: number;
  uri?: string;
}

/**
 * One catalogue row as the ML dataset builder needs it.
 *
 * Text and the three columns that supervise it — nothing else. `manufacturer` is
 * the brand supervision signal, `size` the unit-size one and `packing_unit` the
 * case/each one; without them the weak labeller would be guessing at exactly the
 * attributes it exists to extract. `raw_product` is deliberately absent: several
 * KB per row over 38k rows is tens of megabytes the builder never reads.
 */
export interface MlExportProductRow {
  sku: string;
  name: string;
  manufacturer?: string;
  size?: string;
  packingUnit?: string;
  supplier?: string;
  categoryRef?: string;
}

export interface MlExportPage {
  products: MlExportProductRow[];
  /** Total rows in the table, so the caller knows when it has them all. */
  total: number;
}

export interface MusgraveProductRepository {
  startSyncRun(spgid: string, categoriesTotal: number): Promise<number>;
  upsertProducts(
    products: readonly ParsedProduct[],
    context: ProductUpsertContext,
  ): Promise<ProductUpsertResult>;
  finishSyncRun(
    syncRunId: number,
    status: ProductSyncStatus,
    counts: ProductSyncCounts,
    error?: string,
  ): Promise<void>;

  /** Read the stored catalogue for local matching. */
  listCatalogue(options?: { limit?: number }): Promise<CatalogueProductRow[]>;

  /** One page of the ML training export, plus the table total. */
  exportForMl(options: { limit: number; offset: number }): Promise<MlExportPage>;

  /** sku → packing unit, for the SKUs given. Missing SKUs are simply absent. */
  packingUnitsBySku(skus: readonly string[]): Promise<Record<string, string>>;
}

export class SupabaseMusgraveProductRepository implements MusgraveProductRepository {
  async startSyncRun(spgid: string, categoriesTotal: number): Promise<number> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('musgrave_product_sync_runs')
      .insert({ spgid, categories_total: categoriesTotal })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Could not start a product sync run: ${error.message}`);
    }

    const id = Number((data as { id: number }).id);
    log.info('Product sync run started', { syncRunId: id, categoriesTotal });
    return id;
  }

  async upsertProducts(
    products: readonly ParsedProduct[],
    context: ProductUpsertContext,
  ): Promise<ProductUpsertResult> {
    if (products.length === 0) {
      return { seen: 0, inserted: 0, updated: 0, unchanged: 0 };
    }

    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc('musgrave_upsert_products', {
      p_products: products as unknown as Record<string, unknown>[],
      p_category_id: context.categoryId,
      p_category_ref: context.categoryRef,
      p_sync_id: context.syncRunId,
    });

    if (error) {
      throw new Error(
        `musgrave_upsert_products failed: ${error.message}` +
          (error.hint ? ` (hint: ${error.hint})` : ''),
      );
    }

    const result = (data ?? {}) as Partial<ProductUpsertResult>;

    return {
      seen: result.seen ?? products.length,
      inserted: result.inserted ?? 0,
      updated: result.updated ?? 0,
      unchanged: result.unchanged ?? 0,
    };
  }

  async finishSyncRun(
    syncRunId: number,
    status: ProductSyncStatus,
    counts: ProductSyncCounts,
    error?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const { error: updateError } = await supabase
      .from('musgrave_product_sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        status,
        categories_total: counts.categoriesTotal,
        categories_processed: counts.categoriesProcessed,
        categories_failed: counts.categoriesFailed,
        pages_fetched: counts.pagesFetched,
        products_seen: counts.productsSeen,
        products_inserted: counts.productsInserted,
        products_updated: counts.productsUpdated,
        products_unchanged: counts.productsUnchanged,
        ...(error ? { error: error.slice(0, 2000) } : {}),
      })
      .eq('id', syncRunId);

    if (updateError) {
      // Never mask the real outcome with a bookkeeping failure.
      log.error('Could not finalize the product sync run', { message: updateError.message });
    }
  }

  async listCatalogue(options: { limit?: number } = {}): Promise<CatalogueProductRow[]> {
    const supabase = getSupabaseClient();
    const products: CatalogueProductRow[] = [];

    for (let from = 0; ; from += READ_PAGE_SIZE) {
      const take =
        options.limit !== undefined
          ? Math.min(READ_PAGE_SIZE, options.limit - products.length)
          : READ_PAGE_SIZE;
      if (take <= 0) break;

      const { data, error } = await supabase
        .from('musgrave_products')
        .select('sku, name, size, manufacturer, sale_price, sale_price_currency, tax_rate, uri')
        .order('sku', { ascending: true })
        .range(from, from + take - 1);

      if (error) {
        throw new Error(`Reading musgrave_products failed: ${error.message}`);
      }

      const rows = (data ?? []) as Record<string, unknown>[];
      for (const row of rows) {
        const sku = String(row.sku ?? '');
        if (!sku) continue;
        products.push({
          sku,
          name: String(row.name ?? ''),
          ...(row.size != null ? { size: String(row.size) } : {}),
          ...(row.manufacturer != null ? { manufacturer: String(row.manufacturer) } : {}),
          ...(row.sale_price != null ? { salePrice: Number(row.sale_price) } : {}),
          ...(row.sale_price_currency != null
            ? { salePriceCurrency: String(row.sale_price_currency) }
            : {}),
          ...(row.tax_rate != null ? { taxRate: Number(row.tax_rate) } : {}),
          ...(row.uri != null ? { uri: String(row.uri) } : {}),
        });
      }

      if (rows.length < take) break;
    }

    log.info('Loaded local catalogue', { products: products.length });

    return products;
  }

  async exportForMl(options: { limit: number; offset: number }): Promise<MlExportPage> {
    const supabase = getSupabaseClient();

    // One page at a time, never the whole table. 38k rows of name+manufacturer
    // is small, but the caller streams it precisely so that number can grow
    // (O'Reilly's 30k lands next) without this becoming a memory question.
    const limit = Math.max(1, Math.min(READ_PAGE_SIZE, Math.floor(options.limit)));
    const offset = Math.max(0, Math.floor(options.offset));

    // Rows with no name have no text to understand, so they are excluded HERE
    // rather than by the caller — otherwise `total` and the page offsets would
    // disagree and the builder could not tell "done" from "gap".
    const { data, error, count } = await supabase
      .from('musgrave_products')
      .select('sku, name, manufacturer, size, packing_unit, supplier, category_ref', {
        count: 'exact',
      })
      .not('name', 'is', null)
      .neq('name', '')
      // Ordered by the unique key, so a page is stable across the whole walk
      // even if a sync writes to the table midway through an export.
      .order('sku', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Exporting musgrave_products failed: ${error.message}`);
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    const products: MlExportProductRow[] = [];

    for (const row of rows) {
      const sku = String(row.sku ?? '').trim();
      const name = String(row.name ?? '').trim();
      if (!sku || !name) continue;
      products.push({
        sku,
        name,
        ...(row.manufacturer != null ? { manufacturer: String(row.manufacturer) } : {}),
        ...(row.size != null ? { size: String(row.size) } : {}),
        ...(row.packing_unit != null ? { packingUnit: String(row.packing_unit) } : {}),
        ...(row.supplier != null ? { supplier: String(row.supplier) } : {}),
        ...(row.category_ref != null ? { categoryRef: String(row.category_ref) } : {}),
      });
    }

    return { products, total: count ?? products.length };
  }

  async packingUnitsBySku(skus: readonly string[]): Promise<Record<string, string>> {
    if (skus.length === 0) return {};

    const supabase = getSupabaseClient();
    const units: Record<string, string> = {};

    // Chunked because a SKU list goes into the URL as an `in` filter, and a
    // 200-line order file would otherwise build a query string long enough for
    // PostgREST to reject outright.
    const CHUNK = 200;
    const unique = [...new Set(skus.filter(Boolean))];

    for (let start = 0; start < unique.length; start += CHUNK) {
      const chunk = unique.slice(start, start + CHUNK);

      const { data, error } = await supabase
        .from('musgrave_products')
        .select('sku, packing_unit')
        .in('sku', chunk);

      if (error) {
        throw new Error(`Reading packing units failed: ${error.message}`);
      }

      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const sku = String(row.sku ?? '').trim();
        const unit = row.packing_unit == null ? '' : String(row.packing_unit).trim();
        if (sku && unit) units[sku] = unit;
      }
    }

    return units;
  }
}
