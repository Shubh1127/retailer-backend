/**
 * Musgrave basket integration.
 *
 * THE ONLY PLACE MUSGRAVE CART REST LIVES. Routes call this; the frontend calls
 * the routes. Nothing outside this file knows the shape of a Musgrave basket,
 * so when the API changes there is exactly one file to change.
 *
 * WHAT THE LIVE API ACTUALLY WANTS
 *
 * Taken from the Musgrave web client's own network traffic, not from a guess:
 *
 *   POST /baskets/current/items?msgSkipFulfillmentCheck&include=basketSummary
 *   [{ "product": "936223", "quantity": { "value": 1, "unit": "330 ml" } }]
 *   → 201 { data: [ { id, product, productName, quantity, pricing, … } ], … }
 *
 * Three details are load-bearing and none of them are obvious:
 *
 *  1. NO `;spgid=` on basket resources. Product and category calls need that
 *     matrix parameter; basket calls 404 with it. Adding it is why an earlier
 *     attempt saw `/baskets/current` 404 and POSTs return 200 with no effect —
 *     the request was reaching a different resource entirely.
 *
 *  2. The body IS an array, so several products go in ONE request. Batching is
 *     supported; `addProducts` uses it.
 *
 *  3. `quantity.unit` is the product's PACKING UNIT ("330 ml", "10 Pack") and
 *     is not optional. It is looked up from the synced catalogue rather than
 *     invented, because a wrong unit is accepted and then means something else.
 *
 * The response returns the created line items directly, `id` being the
 * `basketItemId` that PATCH and DELETE need.
 *
 * SUPPLIER BASKET IS THE SOURCE OF TRUTH
 *
 * Nothing here holds cart state between calls. Every mutation is followed by a
 * read, and the UI renders what the read returned. A local mirror would drift
 * the moment a buyer touched the Musgrave site in another tab.
 */

import {
  MusgraveApiError,
  musgraveApiGet,
  musgraveApiSend,
} from './musgrave.service.js';
import { createLogger } from '../log.js';

const log = createLogger('musgrave:cart');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One line as it exists in the supplier's basket. */
export interface BasketLineItem {
  /** The handle PATCH and DELETE need. */
  basketItemId: string;
  /** Musgrave SKU. The join key back to a Ready To Order row. */
  sku: string;
  name?: string;
  quantity: number;
  /** The unit Musgrave counts this line in, e.g. "330 ml", "10 Pack". */
  quantityUnit?: string;
  /** Ex-VAT price for one of `quantityUnit`. */
  singleBasePrice?: number;
  /** Ex-VAT price for the whole line. */
  totalPrice?: number;
  /** Deposit Return Scheme charge, when the product carries one. */
  depositCharge?: number;
  /** Pack as Musgrave states it, e.g. "24 x 330 ml". */
  size?: string;
}

export interface BasketTotals {
  itemTotal?: number;
  /** Ex-VAT where the API states it separately. */
  netTotal?: number;
  grossTotal?: number;
  taxTotal?: number;
  currency: string;
}

export interface MusgraveBasket {
  /** Absent when the account has no basket at all. */
  basketId?: string;
  /** True when there is no basket, or one with nothing in it. */
  isEmpty: boolean;
  lineItems: BasketLineItem[];
  totals: BasketTotals;
  /** sku → line, for joining against Ready To Order rows without a scan. */
  bySku: Record<string, BasketLineItem>;
}

export interface AddProductRequest {
  sku: string;
  quantity: number;
  /** Passed through when the caller knows it; Musgrave infers it otherwise. */
  unit?: string;
  /** Carried only so failures can be reported against a readable name. */
  name?: string;
}

export type AddOutcome = 'added' | 'updated' | 'failed' | 'skipped';

export interface AddResult {
  sku: string;
  name?: string;
  outcome: AddOutcome;
  basketItemId?: string;
  quantity?: number;
  error?: string;
}

export interface AddProductsResult {
  results: AddResult[];
  added: number;
  updated: number;
  failed: number;
  skipped: number;
  /** The basket as it stands after every attempt. */
  basket: MusgraveBasket;
}

export interface ValidationMessage {
  code?: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** Present when the message is about one line rather than the basket. */
  sku?: string;
}

export interface BasketValidation {
  valid: boolean;
  messages: ValidationMessage[];
  basket: MusgraveBasket;
}

// ---------------------------------------------------------------------------
// Raw wire shapes — only what is read, so unknown fields cannot break parsing
// ---------------------------------------------------------------------------

interface RawMoney {
  value?: number;
  currency?: string;
  currencyMnemonic?: string;
}

/** Intershop reports most money as a net/gross pair. Net is ex-VAT. */
interface RawPrice {
  net?: RawMoney;
  gross?: RawMoney;
}

/**
 * A basket line, in EITHER of the two shapes Musgrave returns.
 *
 * `GET /baskets/{id}/items` and `POST /baskets/{id}/items` describe the same
 * line differently, and both are real:
 *
 *   GET   { id, name, product: {title:"936223"}, quantity, totals:{total}, price }
 *   POST  { id, productName, product: "936223",  quantity, pricing:{price:{net}} }
 *
 * Only `id` and `quantity` are spelled the same way. Parsing both here rather
 * than in two places is what keeps the rest of the file unaware of which call
 * it came from.
 */
interface RawLineItem {
  /** THE basketItemId. Intershop just calls it `id`. */
  id?: string;
  basket?: string;
  /** A bare SKU from POST, or a Link whose `title` is the SKU from GET. */
  product?: string | { title?: string; description?: string };
  productName?: string;
  name?: string;
  position?: number;
  quantity?: { value?: number; unit?: string };
  size?: string;
  available?: string | boolean;
  inStock?: string | boolean;
  /** GET shape. */
  totals?: { total?: RawMoney };
  price?: RawMoney | RawPrice;
  singleBasePrice?: RawMoney | RawPrice;
  /** POST shape. */
  pricing?: {
    price?: RawPrice;
    singleBasePrice?: RawPrice;
    salesTaxTotal?: RawMoney;
    /** Deposit Return Scheme charge — a real cost, shown separately. */
    drsTotalCharge?: RawPrice;
  };
}

interface RawBasket {
  id?: string;
  purchaseCurrency?: string;
  totals?: Record<string, RawMoney | RawPrice | undefined>;
  shippingBuckets?: { lineItems?: RawLineItem[] }[];
  lineItems?: RawLineItem[];
  salesTaxTotalsByTaxRate?: { amount?: RawMoney }[];
}

/** The 201 body from POST .../items. */
interface RawAddResponse {
  data?: RawLineItem[];
  included?: {
    basketSummary?: Record<
      string,
      { totalProductQuantity?: number; totals?: { itemTotal?: RawPrice } }
    >;
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function money(value: RawMoney | undefined): number | undefined {
  return typeof value?.value === 'number' && Number.isFinite(value.value)
    ? value.value
    : undefined;
}

/** Net, i.e. ex-VAT. The dashboard compares ex-VAT prices everywhere else. */
function net(price: RawPrice | RawMoney | undefined): number | undefined {
  if (!price) return undefined;
  if ('net' in price || 'gross' in price) {
    return money((price as RawPrice).net) ?? money((price as RawPrice).gross);
  }
  return money(price as RawMoney);
}

function gross(price: RawPrice | RawMoney | undefined): number | undefined {
  if (!price) return undefined;
  if ('gross' in price || 'net' in price) {
    return money((price as RawPrice).gross) ?? money((price as RawPrice).net);
  }
  return money(price as RawMoney);
}

function toLineItem(raw: RawLineItem): BasketLineItem | undefined {
  // Without an id the line cannot be changed or removed, and without a SKU it
  // cannot be joined to a Ready To Order row. Either way it is not actionable,
  // so it is dropped rather than shown as something the buyer can control.
  const basketItemId = raw.id;
  const sku =
    typeof raw.product === 'string' ? raw.product : (raw.product?.title ?? '');
  if (!basketItemId || !sku) return undefined;

  const quantity = raw.quantity?.value;
  const unitPrice = net(raw.pricing?.singleBasePrice) ?? net(raw.singleBasePrice);
  const total = net(raw.pricing?.price) ?? money(raw.totals?.total) ?? net(raw.price);
  const deposit = net(raw.pricing?.drsTotalCharge);
  const name =
    raw.productName ??
    raw.name ??
    (typeof raw.product === 'object' ? raw.product?.description : undefined);

  return {
    basketItemId,
    sku,
    ...(name ? { name } : {}),
    quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : 0,
    ...(raw.quantity?.unit ? { quantityUnit: raw.quantity.unit } : {}),
    ...(unitPrice !== undefined ? { singleBasePrice: unitPrice } : {}),
    ...(total !== undefined ? { totalPrice: total } : {}),
    // Shown separately because it is a real charge the buyer pays and it is not
    // part of the product price they compared suppliers on.
    ...(deposit !== undefined && deposit > 0 ? { depositCharge: deposit } : {}),
    ...(raw.size ? { size: raw.size } : {}),
  };
}

/**
 * Line items, wherever this basket happens to keep them.
 *
 * `include=lineItems` does NOT put them at the top level — on the live API they
 * hang off `shippingBuckets`. Both places are read because a basket mid-way
 * through fulfilment resolution has been observed with one populated and not
 * the other, and missing a line means showing a buyer an empty cart that isn't.
 */
function extractLineItems(raw: RawBasket): BasketLineItem[] {
  const candidates = [
    ...(raw.lineItems ?? []),
    ...(raw.shippingBuckets ?? []).flatMap((bucket) => bucket.lineItems ?? []),
  ];

  const seen = new Set<string>();
  const items: BasketLineItem[] = [];

  for (const candidate of candidates) {
    const item = toLineItem(candidate);
    if (!item || seen.has(item.basketItemId)) continue;
    seen.add(item.basketItemId);
    items.push(item);
  }

  return items;
}

function extractTotals(raw: RawBasket, lineItems: BasketLineItem[]): BasketTotals {
  const totals = raw.totals ?? {};
  const tax = (raw.salesTaxTotalsByTaxRate ?? []).reduce(
    (sum, entry) => sum + (money(entry.amount) ?? 0),
    0,
  );

  const itemTotal = totals.itemTotal;
  const basketTotal = totals.basketTotal ?? totals.grandTotal;

  // Musgrave leaves `totals` sparse until the basket is calculated, so the
  // ex-VAT figure falls back to summing the lines. Reporting nothing would make
  // the confirmation modal say "—" for the very number the buyer is agreeing to.
  const summed = lineItems.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);

  return {
    ...(net(itemTotal) !== undefined ? { itemTotal: net(itemTotal)! } : {}),
    ...(net(itemTotal ?? undefined) !== undefined || summed > 0
      ? { netTotal: net(itemTotal) ?? Number(summed.toFixed(2)) }
      : {}),
    ...(gross(basketTotal ?? itemTotal) !== undefined
      ? { grossTotal: gross(basketTotal ?? itemTotal)! }
      : {}),
    ...(tax > 0 ? { taxTotal: Number(tax.toFixed(2)) } : {}),
    currency: raw.purchaseCurrency ?? 'EUR',
  };
}

function toBasket(basketId: string | undefined, raw: RawBasket | undefined): MusgraveBasket {
  if (!raw) {
    return {
      isEmpty: true,
      lineItems: [],
      totals: { currency: 'EUR' },
      bySku: {},
    };
  }

  const lineItems = extractLineItems(raw);

  return {
    ...(basketId ?? raw.id ? { basketId: (basketId ?? raw.id)! } : {}),
    isEmpty: lineItems.length === 0,
    lineItems,
    totals: extractTotals(raw, lineItems),
    bySku: Object.fromEntries(lineItems.map((item) => [item.sku, item])),
  };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Retry transient failures only.
 *
 * A 4xx means the request was wrong and will be wrong again — retrying it just
 * makes a buyer wait longer for the same answer. 5xx and network faults are
 * worth another attempt; a supplier portal briefly 502-ing mid-run should not
 * cost the line.
 */
async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = error instanceof MusgraveApiError ? error.status : 0;
      const retryable = status === 0 || status >= 500 || status === 429;
      if (!retryable || attempt === attempts) break;
      const wait = 250 * 2 ** (attempt - 1);
      log.warn(`${label} failed, retrying`, { attempt, status, wait });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const BASKET_INCLUDE = 'discounts,lineItems,itemPromotions,buckets,invoiceToAddress';

/**
 * Resolve the basket id.
 *
 * `current` is tried first because that is the documented handle and it works
 * once the basket has anything in it. When it 404s the collection is consulted,
 * which has proved reliable in both states. Returns undefined only when the
 * account genuinely has no basket.
 */
/** Basket calls carry no `;spgid=`, so every one of them passes this. */
const NO_SPGID = { useSpgid: false } as const;

/**
 * Basket writes need Intershop's versioned media type. Plain
 * `application/json` returns 406 Not Acceptable — the server has no
 * representation matching it. Taken from the Musgrave client's own headers.
 */
const BASKET_WRITE = {
  useSpgid: false,
  accept: 'application/vnd.intershop.basket.v1+json',
} as const;

/**
 * The basket id to address.
 *
 * `current` is an alias Intershop resolves from the SESSION, and a session
 * established with `authentication-token` does not carry one — it 404s with
 * "No basket found for the given ID" even though the account plainly has a
 * basket. The browser client gets away with `current` because its cookie
 * session has one bound.
 *
 * So the id is read from `GET /baskets`, which lists it in both states, and
 * every later call addresses the basket explicitly. Cached for the process
 * lifetime because it does not change between requests; a 404 anywhere clears
 * it so a new basket is picked up rather than a stale one retried forever.
 */
let cachedBasketId: string | null = null;

async function resolveBasketId(): Promise<string | undefined> {
  if (cachedBasketId) return cachedBasketId;

  const { data } = await musgraveApiGet<{ elements?: { title?: string }[] }>(
    'baskets',
    {},
    NO_SPGID,
  );

  cachedBasketId = data.elements?.[0]?.title ?? null;
  return cachedBasketId ?? undefined;
}

function forgetBasketId(): void {
  cachedBasketId = null;
}

/** The basket exactly as Musgrave currently holds it. */
export async function getCurrentBasket(): Promise<MusgraveBasket> {
  const basketId = await withRetry('resolve basket id', resolveBasketId);
  if (!basketId) return toBasket(undefined, undefined);

  try {
    // Two calls, because neither answers the whole question. The basket carries
    // the totals and tax but reports `shippingBuckets: []` even when it holds
    // stock; the items sub-resource is where the lines actually live.
    const [basket, items] = await Promise.all([
      withRetry('read basket', () =>
        musgraveApiGet<RawBasket>(`baskets/${basketId}`, { include: BASKET_INCLUDE }, NO_SPGID),
      ),
      withRetry('read basket items', () =>
        musgraveApiGet<{ elements?: RawLineItem[] }>(
          `baskets/${basketId}/items`,
          {},
          NO_SPGID,
        ),
      ).catch(() => ({ data: { elements: [] as RawLineItem[] } })),
    ]);

    return toBasket(basketId, {
      ...basket.data,
      lineItems: items.data.elements ?? [],
    });
  } catch (error) {
    if (error instanceof MusgraveApiError && error.status === 404) {
      // The id we held is gone. Drop it so the next call re-resolves rather
      // than retrying a basket that no longer exists.
      forgetBasketId();
      return toBasket(undefined, undefined);
    }
    throw error;
  }
}

/**
 * How many products go in one POST.
 *
 * The endpoint takes an array, so this could be the whole basket at once. It is
 * capped because a partial failure inside a batch is reported against the batch
 * rather than the product: a chunk of 20 that fails costs 20 lines their
 * individual verdict, and the buyer wants to know WHICH SKU was delisted.
 * Twenty keeps a 200-line file to ten requests while keeping the blast radius
 * small enough to re-try per product.
 */
const ADD_BATCH_SIZE = 20;

/**
 * sku → packing unit, from the synced catalogue.
 *
 * Falls back to sending no unit when the SKU is not in the local catalogue —
 * Musgrave then applies its own default, which is better than guessing a unit
 * and having the line silently mean a different quantity. A lookup failure is
 * downgraded to a warning for the same reason: no unit is recoverable, a wrong
 * one is not.
 */
async function resolvePackingUnits(
  requests: readonly AddProductRequest[],
): Promise<Record<string, string>> {
  const missing = requests.filter((request) => !request.unit).map((request) => request.sku);
  if (missing.length === 0) return {};

  try {
    const { SupabaseMusgraveProductRepository } = await import(
      '../repositories/musgraveProduct.repository.js'
    );
    return await new SupabaseMusgraveProductRepository().packingUnitsBySku(missing);
  } catch (error) {
    log.warn('Could not read packing units — Musgrave will apply its default', {
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Add a batch of products in ONE request.
 *
 * Returns the created lines, `id` being the basketItemId. Musgrave answers 201
 * with the line items directly, so no follow-up read is needed to learn them —
 * though the basket is still re-read afterwards, because it is the source of
 * truth and a batch can be partially applied.
 */
async function addBatch(
  requests: readonly AddProductRequest[],
): Promise<BasketLineItem[]> {
  const basketId = await resolveBasketId();
  if (!basketId) {
    throw new Error(
      'No Musgrave basket exists for this account — open the Musgrave site once to create one.',
    );
  }

  // AN ARRAY, so several products go in one request.
  //
  // Which body shape is accepted depends on the `Accept` header, which is not
  // obvious and cost several wrong turns. With plain `application/json` the
  // endpoint takes a single object and rejects an array; with Intershop's
  // versioned `application/vnd.intershop.basket.v1+json` it takes the array and
  // answers 201 with the created lines. The versioned type is what the Musgrave
  // client sends, so that is what is used here — and batching comes with it.
  const body = requests.map((request) => ({
    product: request.sku,
    quantity: {
      value: request.quantity,
      ...(request.unit ? { unit: request.unit } : {}),
    },
  }));

  const { data } = await musgraveApiSend<RawAddResponse>(
    'POST',
    `baskets/${basketId}/items`,
    body,
    { msgSkipFulfillmentCheck: null, include: 'basketSummary' },
    BASKET_WRITE,
  );

  return (data?.data ?? [])
    .map(toLineItem)
    .filter((item): item is BasketLineItem => item !== undefined);
}

/**
 * Add many products.
 *
 * BATCHED, because the endpoint takes an array — a 200-line order file costs
 * ten requests rather than two hundred. When a batch fails as a whole it is
 * retried PRODUCT BY PRODUCT, so a single delisted SKU costs itself and not the
 * nineteen lines it happened to travel with.
 *
 * ONE FAILURE NEVER STOPS THE RUN. Every product ends with a recorded outcome.
 */
export async function addProducts(
  requests: readonly AddProductRequest[],
  onProgress?: (completed: number, total: number) => void,
): Promise<AddProductsResult> {
  const results: AddResult[] = [];

  if (requests.length === 0) {
    return {
      results,
      added: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      basket: await getCurrentBasket(),
    };
  }

  // What is already there decides added-vs-updated, and lets an unchanged line
  // be skipped rather than re-sent.
  const existing = (await getCurrentBasket()).bySku;

  // `quantity.unit` is not decoration — Musgrave counts the line in it, and a
  // wrong one is accepted and then means something else ("1 × 330 ml" is not
  // "1 × case"). It is looked up from the synced catalogue rather than derived
  // from the search card, whose `size` is the CASE ("24 x 330 ml") and not the
  // unit ("330 ml").
  const units = await resolvePackingUnits(requests);

  const toAdd: AddProductRequest[] = [];

  for (const request of requests) {
    const already = existing[request.sku];
    if (!already) {
      toAdd.push({
        ...request,
        ...(request.unit ?? units[request.sku]
          ? { unit: (request.unit ?? units[request.sku])! }
          : {}),
      });
      continue;
    }
    if (already.quantity >= request.quantity) {
      results.push({
        sku: request.sku,
        ...(request.name ? { name: request.name } : {}),
        outcome: 'skipped',
        basketItemId: already.basketItemId,
        quantity: already.quantity,
        error: `Already in the basket at quantity ${already.quantity}`,
      });
      continue;
    }
    try {
      await updateQuantity(already.basketItemId, request.quantity, request.sku);
      results.push({
        sku: request.sku,
        ...(request.name ? { name: request.name } : {}),
        outcome: 'updated',
        basketItemId: already.basketItemId,
        quantity: request.quantity,
      });
    } catch (error) {
      results.push({
        sku: request.sku,
        ...(request.name ? { name: request.name } : {}),
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let completed = requests.length - toAdd.length;
  onProgress?.(completed, requests.length);

  for (let start = 0; start < toAdd.length; start += ADD_BATCH_SIZE) {
    const batch = toAdd.slice(start, start + ADD_BATCH_SIZE);

    try {
      await withRetry(`add batch of ${batch.length}`, () => addBatch(batch));
      for (const request of batch) {
        results.push({
          sku: request.sku,
          ...(request.name ? { name: request.name } : {}),
          outcome: 'added',
          quantity: request.quantity,
        });
      }
    } catch (batchError) {
      // The batch as a whole was rejected. Fall back to one request per product
      // so the failure is attributed to the SKU that caused it rather than to
      // everything that travelled with it.
      log.warn('Batch add failed, retrying individually', {
        size: batch.length,
        message: batchError instanceof Error ? batchError.message : String(batchError),
      });

      for (const request of batch) {
        try {
          await withRetry(`add ${request.sku}`, () => addBatch([request]));
          results.push({
            sku: request.sku,
            ...(request.name ? { name: request.name } : {}),
            outcome: 'added',
            quantity: request.quantity,
          });
        } catch (error) {
          results.push({
            sku: request.sku,
            ...(request.name ? { name: request.name } : {}),
            outcome: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    completed += batch.length;
    onProgress?.(completed, requests.length);
  }

  // Re-read once at the end. The basket is the source of truth, and this is
  // what turns "Musgrave said 201" into "the line is really there".
  const basket = await getCurrentBasket();

  for (const result of results) {
    const line = basket.bySku[result.sku];
    if (line) {
      result.basketItemId = line.basketItemId;
      result.quantity = line.quantity;
    } else if (result.outcome === 'added') {
      // Reported success but absent from the basket — say so rather than
      // showing the buyer a green tick for a line that is not there.
      result.outcome = 'failed';
      result.error = 'Musgrave accepted the request but the line is not in the basket';
    }
  }

  const count = (outcome: AddOutcome) =>
    results.filter((result) => result.outcome === outcome).length;

  log.info('Add to basket complete', {
    requested: requests.length,
    added: count('added'),
    updated: count('updated'),
    failed: count('failed'),
    skipped: count('skipped'),
  });

  return {
    results,
    added: count('added'),
    updated: count('updated'),
    failed: count('failed'),
    skipped: count('skipped'),
    basket,
  };
}

/** Set a line's quantity. `sku` is required by the API alongside the id. */
export async function updateQuantity(
  basketItemId: string,
  quantity: number,
  sku: string,
): Promise<MusgraveBasket> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('quantity must be a whole number of 0 or more');
  }

  // Zero means remove. Musgrave has a delete endpoint for that, and sending a
  // zero quantity to PATCH leaves an empty line on some Intershop builds.
  if (quantity === 0) return removeItem(basketItemId);

  const basketId = await resolveBasketId();
  if (!basketId) throw new Error('No Musgrave basket to update');

  await withRetry(`patch ${basketItemId}`, () =>
    musgraveApiSend(
      'PATCH',
      `baskets/${basketId}/items/${basketItemId}`,
      { product: sku, quantity: { value: quantity } },
      // Not optional. Without these the endpoint answers 406 Not Acceptable —
      // Intershop selects the representation from the query, so a PATCH with no
      // `include` has no acceptable response to produce.
      { msgSkipFulfillmentCheck: null, include: 'basketSummary' },
      BASKET_WRITE,
    ),
  );

  return getCurrentBasket();
}

/** Remove a line entirely. Called when a quantity stepper reaches zero. */
export async function removeItem(basketItemId: string): Promise<MusgraveBasket> {
  const basketId = await resolveBasketId();
  if (!basketId) throw new Error('No Musgrave basket to remove from');

  try {
    await withRetry(`delete ${basketItemId}`, () =>
      musgraveApiSend(
        'DELETE',
        `baskets/${basketId}/items/${basketItemId}`,
        undefined,
        // DELETE takes no query parameters — the client sends a bare path.
        {},
        BASKET_WRITE,
      ),
    );
  } catch (error) {
    // Already gone is the outcome the caller wanted.
    if (!(error instanceof MusgraveApiError) || error.status !== 404) throw error;
  }

  return getCurrentBasket();
}

/**
 * Ask Musgrave to validate the basket.
 *
 * Run after a bulk add so the buyer learns about a minimum order value or a
 * delisted product before they go to the Musgrave site, not after.
 */
export async function validateBasket(): Promise<BasketValidation> {
  const basket = await getCurrentBasket();
  const basketId = basket.basketId;

  if (basket.isEmpty || !basketId) {
    return {
      valid: false,
      messages: [{ severity: 'info', message: 'The Musgrave basket is empty.' }],
      basket,
    };
  }

  try {
    const { data } = await withRetry('validate basket', () =>
      musgraveApiSend<{
        data?: { infos?: RawValidationEntry[]; errors?: RawValidationEntry[] };
        infos?: RawValidationEntry[];
        errors?: RawValidationEntry[];
      }>(
        'POST',
        `baskets/${basketId}/validations`,
        {
          basket: 'current',
          adjustmentsAllowed: true,
          scopes: ['Products', 'Value'],
        },
        { include: 'basket' },
        BASKET_WRITE,
      ),
    );

    const payload = data?.data ?? data ?? {};
    const messages = [
      ...toMessages(payload.errors, 'error'),
      ...toMessages(payload.infos, 'info'),
    ];

    return {
      valid: messages.every((message) => message.severity !== 'error'),
      messages,
      basket: await getCurrentBasket(),
    };
  } catch (error) {
    // A validation call that cannot run is not a basket that is invalid. Say
    // which one it is, so nobody reads an outage as a rejected order.
    return {
      valid: false,
      messages: [
        {
          severity: 'warning',
          message: `Could not validate the basket: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      basket,
    };
  }
}

interface RawValidationEntry {
  code?: string;
  message?: string;
  parameters?: { lineItem?: string; sku?: string };
}

function toMessages(
  entries: RawValidationEntry[] | undefined,
  severity: ValidationMessage['severity'],
): ValidationMessage[] {
  return (entries ?? [])
    .filter((entry) => entry.message || entry.code)
    .map((entry) => ({
      severity,
      message: entry.message ?? entry.code ?? 'Unknown validation message',
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.parameters?.sku ? { sku: entry.parameters.sku } : {}),
    }));
}
