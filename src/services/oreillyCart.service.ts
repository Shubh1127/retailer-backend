/**
 * O'Reilly basket.
 *
 * The second supplier cart, after Musgrave. It answers the same contract, but
 * almost nothing about the mechanism is the same:
 *
 *   Musgrave   a JSON REST API, basket addressed by id, one call per operation
 *   O'Reilly   a classic ASP site — HTML pages, state in the session cookie
 *
 *   read      GET  /products/basket.asp                     → HTML, scraped
 *   add       GET  /products/AddLine.asp?ProdCode=&Qty=      → XML
 *   set qty   GET  /products/update.asp?prodbasket_key=K
 *                  &prodbasket_key_K_newqty=N               → 302 to basket.asp
 *   remove    the same call with newqty=0
 *
 * THE BASKET IS THE SOURCE OF TRUTH, AND HERE THAT IS LOAD-BEARING
 *
 * `AddLine.asp` answers with XML whose success/failure contract is not
 * documented and not obvious — a 200 proves the request was served, not that a
 * line was added. So nothing here trusts a mutation's own response. Every
 * operation re-reads `basket.asp` and reports what is actually in it. That is
 * slower by one request and immune to a silent no-op, which is the trade worth
 * making when the alternative is telling a buyer their order contains something
 * it does not.
 *
 * TWO HAZARDS OF AN ASP SITE
 *
 *  1. **Mutations are GETs.** A retry, a prefetch or a double submit adds
 *     again. Nothing here retries a mutation, and callers must not either.
 *  2. **An expired session returns the LOGIN PAGE with a 200.** Parsed naively
 *     that reads as "the basket is empty" — the single most dangerous wrong
 *     answer this module could give, because empty invites re-adding
 *     everything. `parseBasket` therefore refuses to report emptiness unless it
 *     can positively identify the basket page first.
 */

import * as cheerio from 'cheerio';

import { parseMoney } from '../connectors/types.js';
import { BASE_URL, ensureSession } from './oreilly.service.js';
import { createLogger } from '../log.js';
// The cart contract shapes. They are declared in the Musgrave module because it
// was the only supplier when they were written; they are not Musgrave-specific
// and should move to a shared module when a third supplier arrives.
import type {
  AddProductRequest,
  AddProductsResult,
  AddResult,
  BasketLineItem,
  BasketTotals,
  BasketValidation,
  MusgraveBasket as SupplierBasket,
} from './musgraveCart.service.js';

const log = createLogger('oreilly-cart');

const BASKET_URL = `${BASE_URL}/products/basket.asp`;
const UPDATE_URL = `${BASE_URL}/products/update.asp`;
const ADD_LINE_URL = `${BASE_URL}/products/AddLine.asp`;

/** The quantity box is `maxlength="3" max="999"`; the server will not take more. */
const MAX_QUANTITY = 999;

export type { SupplierBasket };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Text of an element with its nested `<div>`s removed.
 *
 * Every size and pack cell carries a hidden `<div>Size:</div>` label that is
 * shown only on narrow screens. Taking `.text()` would yield "Size: 375gm".
 */
function cellText($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>): string {
  const clone = element.clone();
  clone.find('div, input').remove();
  return clone.text().replace(/\s+/g, ' ').trim();
}

/**
 * Is this actually the basket page?
 *
 * `<html id="Basket">` is the marker, because it is the only one present in
 * BOTH states. An empty basket renders neither the header table nor the update
 * form — it renders "Your basket is currently empty." and a carousel of
 * suggestions — so keying on those would reject a perfectly healthy empty
 * basket as a session failure.
 *
 * The others are kept as fallbacks in case the id ever moves.
 *
 * Why this check exists at all: a logged-out request redirects to
 * `/default.asp?timeout=1`, which the client follows and returns as 200 HTML.
 * Nothing in the status code distinguishes it from a basket.
 */
function isBasketPage($: cheerio.CheerioAPI): boolean {
  return (
    $('html#Basket').length > 0 ||
    $('#BasketTable').length > 0 ||
    $('form[action*="update.asp"]').length > 0 ||
    /your basket is currently empty/i.test($('body').text())
  );
}

/** Read one money cell, or undefined when it is missing or unparseable. */
function money(text: string): number | undefined {
  if (!text) return undefined;
  const value = parseMoney(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Basket totals.
 *
 * The page states Discount, Total Savings and Order Total — and NO VAT line.
 * So `netTotal` is filled and `taxTotal`/`grossTotal` are deliberately left
 * undefined rather than derived: O'Reilly's trade prices are ex-VAT
 * (`priceIncludesVat: false` on its search cards), and inventing a tax figure
 * would put a number on screen that no supplier ever quoted.
 */
function parseTotals($: cheerio.CheerioAPI): BasketTotals {
  let orderTotal: number | undefined;

  $('#SummTable tr').each((_, tr) => {
    const cells = $(tr).find('td');
    const label = cells.first().text().toLowerCase();
    if (label.includes('order total')) {
      orderTotal = money(cells.last().text());
    }
  });

  // The mobile status bar states the same figure. Used only when the summary
  // table did not parse — its markup has unclosed tags and may shift.
  if (orderTotal === undefined) {
    orderTotal = money($('#MobileTotalStatus').text());
  }

  return {
    ...(orderTotal !== undefined ? { itemTotal: orderTotal } : {}),
    ...(orderTotal !== undefined ? { netTotal: orderTotal } : {}),
    currency: 'EUR',
  };
}

/**
 * Turn a basket page into the contract shape.
 *
 * Throws rather than returning an empty basket when the page is not the basket
 * — see the module header. A caller that gets an exception retries or reports;
 * a caller handed `isEmpty: true` acts on it.
 */
export function parseBasket(html: string): SupplierBasket {
  const $ = cheerio.load(html);

  if (!isBasketPage($)) {
    // A logged-out request lands on /default.asp?timeout=1 after the redirect,
    // so the login form is the specific thing worth naming.
    const looksLikeLogin = $('input[name="password"]').length > 0;

    throw new Error(
      looksLikeLogin
        ? "O'Reilly returned the login page — the session has expired. The " +
          'basket was NOT read; it is not empty.'
        : "O'Reilly returned a page that is not the basket. The basket was " +
          'NOT read; it is not empty.',
    );
  }

  const lineItems: BasketLineItem[] = [];

  // `id` is repeated on every line, which is invalid HTML and irrelevant to a
  // CSS selector — this matches all of them, which is what the page means.
  $('div[id="BasketDetails"]').each((_, element) => {
    const line = $(element);

    const codeCell = line.find('li.ProductCode');
    const basketItemId =
      codeCell.find('input[name="prodbasket_key"]').attr('value')?.trim() ?? '';
    // Read from the cell text, NOT parsed as a number: codes carry leading
    // zeros ("048698") and Number() would silently destroy them.
    const sku = cellText($, codeCell);

    if (!basketItemId || !sku) return;

    const name = line.find('li.ProdDesc a').text().replace(/\s+/g, ' ').trim();
    const size = cellText($, line.find('li.ProdSize'));
    const pack = cellText($, line.find('li.ProdPack'));
    const unitPrice = money(cellText($, line.find('li.ProdPrice')));

    const quantity = Number(
      line.find(`input[name="prodbasket_key_${basketItemId}_newqty"]`).attr('value') ??
        '0',
    );
    const safeQuantity = Number.isFinite(quantity) ? quantity : 0;

    lineItems.push({
      basketItemId,
      sku,
      ...(name ? { name } : {}),
      quantity: safeQuantity,
      // "24 × 330ml" reads the way the pack does everywhere else in the app.
      ...(pack && size ? { quantityUnit: `${pack} × ${size}` } : {}),
      ...(unitPrice !== undefined ? { singleBasePrice: unitPrice } : {}),
      // The page shows no line total, so it is computed. The arithmetic is
      // verifiable: the sum of these equals the stated Order Total.
      ...(unitPrice !== undefined
        ? { totalPrice: Number((unitPrice * safeQuantity).toFixed(2)) }
        : {}),
    });
  });

  const bySku: Record<string, BasketLineItem> = {};
  for (const item of lineItems) bySku[item.sku] = item;

  return {
    isEmpty: lineItems.length === 0,
    lineItems,
    totals: parseTotals($),
    bySku,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** The basket exactly as O'Reilly holds it. */
export async function getCurrentBasket(): Promise<SupplierBasket> {
  const session = await ensureSession();
  const response = await session.client.get(BASKET_URL);
  return parseBasket(response.data as string);
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('quantity must be a whole number of 0 or more');
  }
  if (quantity > MAX_QUANTITY) {
    throw new Error(`O'Reilly accepts at most ${MAX_QUANTITY} per line`);
  }
}

/**
 * Set a line's quantity. Zero removes it, which is O'Reilly's own mechanism —
 * the basket's X link is exactly this call with `newqty=0`.
 *
 * The response is a 302 to basket.asp and the client follows redirects, so the
 * body IS the updated basket. One request, no read-back needed.
 */
export async function updateQuantity(
  basketItemId: string,
  quantity: number,
): Promise<SupplierBasket> {
  assertQuantity(quantity);

  const session = await ensureSession();

  // The key is part of the PARAMETER NAME, not just its value. Built by
  // interpolation because no params object can express that.
  const query =
    `prodbasket_key=${encodeURIComponent(basketItemId)}` +
    `&prodbasket_key_${encodeURIComponent(basketItemId)}_newqty=${quantity}`;

  const response = await session.client.get(`${UPDATE_URL}?${query}`);
  return parseBasket(response.data as string);
}

export async function removeItem(basketItemId: string): Promise<SupplierBasket> {
  return updateQuantity(basketItemId, 0);
}

/**
 * Add products, one at a time.
 *
 * SEQUENTIAL ON PURPOSE. These are state-changing GETs against one ASP session;
 * firing them concurrently races the session's own basket state, and the site
 * gives no way to detect that it happened.
 *
 * A product already in the basket is SET to the requested quantity via
 * `update.asp` rather than added again. `AddLine`'s behaviour for an existing
 * line — add to it, or replace it — is not established, and this route is
 * correct under either reading, which is why it is taken rather than tested.
 */
export async function addProducts(
  requests: readonly AddProductRequest[],
  onProgress?: (completed: number, total: number) => void,
): Promise<AddProductsResult> {
  const results: AddResult[] = [];

  let basket = await getCurrentBasket();

  for (const [index, request] of requests.entries()) {
    const label = { sku: request.sku, ...(request.name ? { name: request.name } : {}) };

    try {
      assertQuantity(request.quantity);

      const existing = basket.bySku[request.sku];

      if (existing) {
        basket = await updateQuantity(existing.basketItemId, request.quantity);
        const line = basket.bySku[request.sku];
        results.push({
          ...label,
          outcome: 'updated',
          ...(line ? { basketItemId: line.basketItemId, quantity: line.quantity } : {}),
        });
      } else {
        const session = await ensureSession();
        await session.client.get(ADD_LINE_URL, {
          params: { ProdCode: request.sku, Qty: request.quantity },
        });

        // The add's own XML answer is not trusted — the basket is re-read and
        // the line's presence there is what "added" means.
        basket = await getCurrentBasket();
        const line = basket.bySku[request.sku];

        if (line) {
          results.push({
            ...label,
            outcome: 'added',
            basketItemId: line.basketItemId,
            quantity: line.quantity,
          });
        } else {
          results.push({
            ...label,
            outcome: 'failed',
            error:
              "O'Reilly accepted the request but the product is not in the " +
              'basket afterwards — the code may be wrong or the line unavailable.',
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Add failed', { sku: request.sku, message });
      results.push({ ...label, outcome: 'failed', error: message });
    }

    onProgress?.(index + 1, requests.length);
  }

  const count = (outcome: AddResult['outcome']) =>
    results.filter((result) => result.outcome === outcome).length;

  return {
    results,
    added: count('added'),
    updated: count('updated'),
    failed: count('failed'),
    skipped: count('skipped'),
    basket,
  };
}

/**
 * O'Reilly has no basket-validation step.
 *
 * Reported as an explicit `info` rather than a silent `valid: true`. A fake
 * pass is worse than an honest "not supported": it would let the UI claim the
 * supplier checked something nobody checked.
 */
export async function validateBasket(): Promise<BasketValidation> {
  const basket = await getCurrentBasket();

  return {
    valid: !basket.isEmpty,
    messages: [
      {
        severity: 'info',
        message: basket.isEmpty
          ? 'The basket is empty.'
          : "O'Reilly does not offer a basket check, so this reports only what " +
            'the basket contains — it is not a supplier-side validation.',
      },
    ],
    basket,
  };
}
