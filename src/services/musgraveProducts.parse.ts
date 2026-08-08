/**
 * Musgrave Product API — parsing only.
 *
 * Product data does not sit at the top level of an element: every property is an
 * entry in `attributes[]` as `{ name, value }`. This module turns that into a
 * typed object, keyed BY NAME — never by position — and ignores attributes it
 * does not recognise, so Musgrave adding fields cannot break a sync. Anything
 * unrecognised still reaches the database inside `raw`.
 *
 * Pure and synchronous: no network, no database.
 */

import { createLogger } from '../log.js';

const log = createLogger('musgrave:products:parse');

// ---------------------------------------------------------------------------
// Raw API shapes
// ---------------------------------------------------------------------------

export interface MusgraveApiProductAttribute {
  name?: string;
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface MusgraveApiProduct {
  title?: string;
  name?: string;
  uri?: string;
  attributes?: MusgraveApiProductAttribute[];
  /** Some responses carry a second bag under PRODUCT_API_ATTRIBUTES. */
  attributeGroup?: { attributes?: MusgraveApiProductAttribute[] };
  attributeGroups?: Record<string, { attributes?: MusgraveApiProductAttribute[] }>;
  [key: string]: unknown;
}

export interface MusgraveProductsPage {
  total?: number;
  offset?: number;
  amount?: number;
  elements?: MusgraveApiProduct[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Parsed shape — the contract with musgrave_upsert_products()
// ---------------------------------------------------------------------------

export interface ParsedProduct {
  sku: string;
  name?: string;
  uri?: string;

  salePrice?: number;
  salePriceCurrency?: string;
  listPrice?: number;
  listPriceCurrency?: string;
  pricePerKilo?: number;
  pricePerKiloCurrency?: string;
  listPricePerKilo?: number;
  listPricePerKiloCurrency?: string;
  rrp?: number;
  rrpCurrency?: string;

  availability?: boolean;
  inStock?: boolean;
  isPromotionalPrice?: boolean;
  drsApplicable?: boolean;
  drsSingleQtyCharge?: number;

  manufacturer?: string;
  supplier?: string;
  image?: string;
  size?: string;
  packingUnit?: string;
  productMasterSku?: string;
  estimatedDeliveryDate?: string;
  minOrderQuantity?: number;
  taxRate?: number;
  uciv?: number;
  por?: number;

  promotions?: unknown;

  /** The verbatim API element. */
  raw: Record<string, unknown>;
}

export interface ParsedProductsPage {
  /** Total products in this category, per the API. Drives pagination. */
  total: number;
  offset: number;
  amount: number;
  products: ParsedProduct[];
  /** Elements returned by this page, including any that failed to parse. */
  elementCount: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

const TRUE_STRINGS = new Set(['true', '1', 'yes', 'y']);
const FALSE_STRINGS = new Set(['false', '0', 'no', 'n']);

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    // Strip currency decoration and separators, then require what remains to be
    // a complete number. Stripping non-digits alone would turn "not a price"
    // into "" and then into 0 — a malformed price silently becoming free.
    const cleaned = value.replace(/[\s €$£,]/g, '');
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  // Money and similar wrappers: { type: 'Money', value: 12.5, currency: 'EUR' }
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return asNumber((value as Record<string, unknown>).value);
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) return true;
    if (FALSE_STRINGS.has(normalized)) return false;
  }
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return asBoolean((value as Record<string, unknown>).value);
  }
  return undefined;
}

/** A Money attribute's amount and currency. */
export function asMoney(value: unknown): { amount?: number; currency?: string } {
  const amount = asNumber(value);
  let currency: string | undefined;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    currency = asString(record.currency) ?? asString(record.currencyMnemonic);
  }
  return {
    ...(amount !== undefined ? { amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
}

/**
 * Index an element's attributes by name.
 *
 * Case-insensitive because the API mixes conventions ("UCIV", "RRP", "sku"), and
 * tolerant of every place attributes can hide. Ordering is never relied upon.
 */
export function indexAttributes(product: MusgraveApiProduct): Map<string, unknown> {
  const index = new Map<string, unknown>();

  const absorb = (attributes: MusgraveApiProductAttribute[] | undefined) => {
    if (!Array.isArray(attributes)) return;
    for (const attribute of attributes) {
      const name = typeof attribute?.name === 'string' ? attribute.name.trim() : '';
      if (!name) continue;
      // First writer wins, so the primary attributes[] bag takes precedence.
      const key = name.toLowerCase();
      if (!index.has(key)) index.set(key, attribute.value);
    }
  };

  absorb(product?.attributes);
  absorb(product?.attributeGroup?.attributes);
  for (const group of Object.values(product?.attributeGroups ?? {})) {
    absorb(group?.attributes);
  }

  return index;
}

/** Transform one API element into a typed product. */
export function parseProduct(
  product: MusgraveApiProduct,
): { product: ParsedProduct } | { error: string } {
  const attributes = indexAttributes(product);
  const get = (name: string) => attributes.get(name.toLowerCase());

  const sku = asString(get('sku'))?.trim();
  if (!sku) {
    return { error: 'Product element has no sku attribute — cannot be stored.' };
  }

  const salePrice = asMoney(get('salePrice'));
  const listPrice = asMoney(get('listPrice'));
  const pricePerKilo = asMoney(get('pricePerKilo'));
  const listPricePerKilo = asMoney(get('listPricePerKilo'));
  const rrp = asMoney(get('RRP'));

  // `title` is the element's own field; some responses expose a name attribute.
  const name = asString(product?.title) ?? asString(product?.name) ?? asString(get('name'));
  const uri = asString(product?.uri);

  const parsed: ParsedProduct = {
    sku,
    raw: product as Record<string, unknown>,

    ...(name !== undefined ? { name } : {}),
    ...(uri !== undefined ? { uri } : {}),

    ...(salePrice.amount !== undefined ? { salePrice: salePrice.amount } : {}),
    ...(salePrice.currency !== undefined ? { salePriceCurrency: salePrice.currency } : {}),
    ...(listPrice.amount !== undefined ? { listPrice: listPrice.amount } : {}),
    ...(listPrice.currency !== undefined ? { listPriceCurrency: listPrice.currency } : {}),
    ...(pricePerKilo.amount !== undefined ? { pricePerKilo: pricePerKilo.amount } : {}),
    ...(pricePerKilo.currency !== undefined
      ? { pricePerKiloCurrency: pricePerKilo.currency }
      : {}),
    ...(listPricePerKilo.amount !== undefined
      ? { listPricePerKilo: listPricePerKilo.amount }
      : {}),
    ...(listPricePerKilo.currency !== undefined
      ? { listPricePerKiloCurrency: listPricePerKilo.currency }
      : {}),
    ...(rrp.amount !== undefined ? { rrp: rrp.amount } : {}),
    ...(rrp.currency !== undefined ? { rrpCurrency: rrp.currency } : {}),
  };

  const assign = <K extends keyof ParsedProduct>(key: K, value: ParsedProduct[K] | undefined) => {
    if (value !== undefined) parsed[key] = value;
  };

  assign('availability', asBoolean(get('availability')));
  assign('inStock', asBoolean(get('inStock')));
  assign('isPromotionalPrice', asBoolean(get('isPromotionalPrice')));
  assign('drsApplicable', asBoolean(get('DRSApplicable')));
  assign('drsSingleQtyCharge', asNumber(get('DRSSingleQtyCharge')));

  assign('manufacturer', asString(get('manufacturer')));
  assign('supplier', asString(get('supplier')));
  assign('image', asString(get('image')));
  assign('size', asString(get('size')));
  assign('packingUnit', asString(get('packingUnit')));
  assign('productMasterSku', asString(get('productMasterSKU')));
  assign('estimatedDeliveryDate', asString(get('estimatedDeliveryDate')));
  assign('minOrderQuantity', asNumber(get('minOrderQuantity')));
  assign('taxRate', asNumber(get('taxRate')));
  assign('uciv', asNumber(get('UCIV')));
  assign('por', asNumber(get('POR')));

  const promotions = get('promotions');
  if (promotions !== undefined && promotions !== null) parsed.promotions = promotions;

  return { product: parsed };
}

/**
 * Parse one page. `total` drives pagination and is taken from the response —
 * never inferred from the number of elements returned.
 */
export function parseProductsPage(
  payload: unknown,
  fallback: { offset: number; amount: number },
): ParsedProductsPage {
  const page = (payload ?? {}) as MusgraveProductsPage;
  const elements = Array.isArray(page.elements) ? page.elements : [];
  const warnings: string[] = [];

  const products: ParsedProduct[] = [];
  for (const element of elements) {
    const result = parseProduct(element);
    if ('error' in result) warnings.push(result.error);
    else products.push(result.product);
  }

  const total =
    typeof page.total === 'number' && Number.isFinite(page.total) ? page.total : products.length;

  if (typeof page.total !== 'number' && elements.length > 0) {
    warnings.push('Response had no numeric "total" — falling back to the element count.');
  }

  const result: ParsedProductsPage = {
    total,
    offset: typeof page.offset === 'number' ? page.offset : fallback.offset,
    amount: typeof page.amount === 'number' ? page.amount : fallback.amount,
    products,
    elementCount: elements.length,
    warnings,
  };

  if (warnings.length > 0) {
    log.warn(`${warnings.length} parse warning(s) on this page`, { first: warnings[0] });
  }

  return result;
}
