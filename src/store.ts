/**
 * Data store — the backend's source of truth for suppliers, the canonical
 * catalog, confirmed matches and current price quotes.
 *
 * Deliberately simple: an in-memory repository with optional JSON-file
 * persistence, so the server runs with zero external dependencies (no database
 * to stand up for a single-shop deployment). Swap `JsonFilePersistence` for a
 * Postgres-backed implementation when multi-store/cloud sync is needed — the
 * `Persistence` interface is the only thing that changes.
 *
 * NOTE: supplier LOGIN credentials are never stored here. Those live on the iPad
 * (Keychain). The server only holds catalog/price/matching data — pure compute.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CanonicalProduct, PriceQuote, ProductMatch, Supplier } from './types.js';
import type { ShopArticle } from './ingest/eposListing.js';

/** A weekly order line the shop is comparing (article mapped to a canonical product). */
export interface OrderLine {
  articleCode: string;
  unitGtin: string; // canonical product it maps to
  description: string;
  packRaw: string;
  cases: number;
  mainCost?: number;
}

export interface StoreData {
  suppliers: Supplier[];
  products: CanonicalProduct[];
  matches: ProductMatch[];
  quotes: PriceQuote[];
  /** Current weekly order list (from EPOS import / scanning). */
  orderLines: OrderLine[];
  /** Raw imported EPOS articles (for reference / re-mapping). */
  shopArticles: ShopArticle[];
  /** Run mode: 'stealth' = read-only (no basket writes), 'full' = writes allowed. */
  mode: 'stealth' | 'full';
  /** Append-only price observations (trend / history). */
  priceHistory: (PriceQuote & { changePct?: number })[];
}

export interface Persistence {
  load(): Promise<StoreData | null>;
  save(data: StoreData): Promise<void>;
}

/** JSON-file persistence (default). */
export class JsonFilePersistence implements Persistence {
  constructor(private readonly path: string) {}
  async load(): Promise<StoreData | null> {
    try {
      const text = await readFile(this.path, 'utf8');
      return JSON.parse(text) as StoreData;
    } catch {
      return null;
    }
  }
  async save(data: StoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data, null, 2), 'utf8');
  }
}

/** No-op persistence for tests. */
export class MemoryPersistence implements Persistence {
  async load(): Promise<StoreData | null> {
    return null;
  }
  async save(): Promise<void> {}
}

/**
 * Default suppliers matching the existing Compare Price app's six wholesalers,
 * with the per-supplier compare thresholds seen in its Settings screen
 * (Musgrave 10%, the rest 13%). Editable via the API.
 */
export function defaultSuppliers(): Supplier[] {
  return [
    { id: 'musgrave', name: 'Musgrave Marketplace', isMain: true, preferenceRank: 1, channel: 'quick-order-paste', minOrderValue: 0, deliveryFee: 0, thresholdPct: 0.10 },
    { id: 'barrygroup', name: 'Barry Group', isMain: false, preferenceRank: 2, channel: 'webview-cart', minOrderValue: 0, deliveryFee: 0, thresholdPct: 0.13 },
    { id: 'oreillys', name: "O'Reillys Wholesale", isMain: false, preferenceRank: 3, channel: 'webview-cart', minOrderValue: 0, deliveryFee: 0, thresholdPct: 0.13 },
    { id: 'kadona', name: 'Kadona Wholesale', isMain: false, preferenceRank: 4, channel: 'webview-cart', minOrderValue: 0, deliveryFee: 0, thresholdPct: 0.13 },
    { id: 'savage', name: 'Savage & Whitten', isMain: false, preferenceRank: 5, channel: 'webview-cart', minOrderValue: 0, deliveryFee: 0, thresholdPct: 0.13 },
    { id: 'valuecentre', name: 'Value Centre Cavan', isMain: false, preferenceRank: 6, channel: 'webview-cart', minOrderValue: 0, deliveryFee: 0, thresholdPct: 0.13 },
  ];
}

export class Store {
  private data: StoreData;

  private constructor(
    data: StoreData,
    private readonly persistence: Persistence,
  ) {
    this.data = data;
  }

  static async open(persistence: Persistence): Promise<Store> {
    const loaded = await persistence.load();
    const data: StoreData = {
      suppliers: defaultSuppliers(),
      products: [], matches: [], quotes: [],
      orderLines: [], shopArticles: [], mode: 'stealth', priceHistory: [],
      ...(loaded ?? {}),
    };
    return new Store(data, persistence);
  }

  private async persist(): Promise<void> {
    await this.persistence.save(this.data);
  }

  // ---- reads ----
  get suppliers(): Supplier[] {
    return this.data.suppliers;
  }
  get products(): CanonicalProduct[] {
    return this.data.products;
  }
  get matches(): ProductMatch[] {
    return this.data.matches;
  }
  get quotes(): PriceQuote[] {
    return this.data.quotes;
  }
  supplierById(id: string): Supplier | undefined {
    return this.data.suppliers.find((s) => s.id === id);
  }

  // ---- writes ----
  async setSuppliers(suppliers: Supplier[]): Promise<void> {
    this.data.suppliers = suppliers;
    await this.persist();
  }

  /**
   * Merge an import result into the store. Products dedupe by GTIN; matches and
   * quotes upsert by their natural key (unitGtin+supplierId, supplierId+sku) so a
   * re-import refreshes prices rather than duplicating rows.
   */
  async mergeImport(input: {
    products?: CanonicalProduct[];
    matches?: ProductMatch[];
    quotes?: PriceQuote[];
  }): Promise<void> {
    if (input.products) {
      const byGtin = new Map(this.data.products.map((p) => [p.unitGtin, p]));
      for (const p of input.products) byGtin.set(p.unitGtin, p);
      this.data.products = [...byGtin.values()];
    }
    if (input.matches) {
      // Key on SKU too: a supplier can list the SAME EAN at multiple pack sizes
      // (e.g. McDonnells Spice Bag 1×600g and 6×600g) — those are distinct
      // orderable products and must not collapse into one.
      const key = (m: ProductMatch) => `${m.unitGtin}:${m.supplierId}:${m.supplierSku}`;
      const byKey = new Map(this.data.matches.map((m) => [key(m), m]));
      for (const m of input.matches) byKey.set(key(m), m);
      this.data.matches = [...byKey.values()];
    }
    if (input.quotes) {
      const key = (q: PriceQuote) => `${q.supplierId}:${q.supplierSku}`;
      const byKey = new Map(this.data.quotes.map((q) => [key(q), q]));
      for (const q of input.quotes) byKey.set(key(q), q);
      this.data.quotes = [...byKey.values()];
    }
    await this.persist();
  }

  // ---- order list / mode / articles ----
  get orderLines(): OrderLine[] { return this.data.orderLines; }
  get shopArticles(): ShopArticle[] { return this.data.shopArticles; }
  get mode(): 'stealth' | 'full' { return this.data.mode; }
  get priceHistory(): (PriceQuote & { changePct?: number })[] { return this.data.priceHistory; }

  async setMode(mode: 'stealth' | 'full'): Promise<void> { this.data.mode = mode; await this.persist(); }
  async setOrderLines(lines: OrderLine[]): Promise<void> { this.data.orderLines = lines; await this.persist(); }
  async setShopArticles(a: ShopArticle[]): Promise<void> { this.data.shopArticles = a; await this.persist(); }
  async appendPriceHistory(rows: (PriceQuote & { changePct?: number })[]): Promise<void> {
    this.data.priceHistory.push(...rows);
    // keep bounded for the interim JSON store
    if (this.data.priceHistory.length > 5000) this.data.priceHistory = this.data.priceHistory.slice(-5000);
    await this.persist();
  }

  /** Replace all products/matches/quotes (used by the demo seeder). */
  async replaceCatalog(input: { products: CanonicalProduct[]; matches: ProductMatch[]; quotes: PriceQuote[] }): Promise<void> {
    this.data.products = input.products;
    this.data.matches = input.matches;
    this.data.quotes = input.quotes;
    await this.persist();
  }

  /** Patch a single match (mappings cockpit edit). Identified by id. */
  async patchMatch(id: string, patch: Partial<ProductMatch>): Promise<ProductMatch | undefined> {
    const idx = this.data.matches.findIndex((m) => (m as ProductMatch & { id?: string }).id === id);
    if (idx < 0) return undefined;
    const current = this.data.matches[idx]!;
    const updated = { ...current, ...patch } as ProductMatch;
    this.data.matches[idx] = updated;
    // is_preferred is exclusive per (gtin, supplier)
    if (patch.isPreferred) {
      for (const m of this.data.matches) {
        if (m !== updated && m.unitGtin === updated.unitGtin && m.supplierId === updated.supplierId) {
          (m as ProductMatch).isPreferred = false;
        }
      }
    }
    await this.persist();
    return updated;
  }

  async replaceQuotes(quotes: PriceQuote[]): Promise<void> { this.data.quotes = quotes; await this.persist(); }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }
}
