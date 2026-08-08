/**
 * HTTP surface for the supplier basket.
 *
 * Thin by design. Every route is parse → call `musgraveCart.service` → send.
 * No basket logic lives here, because a rule that exists in a route handler is
 * a rule the next caller will not get.
 *
 * MUSGRAVE ONLY, for now. The supplier is in the path rather than a body field
 * so that adding O'Reilly is a new branch beside this one, not a conditional
 * threaded through it.
 *
 *   GET    /api/cart/musgrave                    the basket, as Musgrave holds it
 *   POST   /api/cart/musgrave/items              add many (one request each)
 *   PATCH  /api/cart/musgrave/items/:id          set a quantity
 *   DELETE /api/cart/musgrave/items/:id          remove a line
 *   POST   /api/cart/musgrave/validate           ask Musgrave to check it
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  addProducts,
  getCurrentBasket,
  removeItem,
  updateQuantity,
  validateBasket,
  type AddProductRequest,
  type AddProductsResult,
  type BasketValidation,
  type MusgraveBasket,
} from './musgraveCart.service.js';
import {
  addProducts as oreillyAddProducts,
  getCurrentBasket as oreillyGetBasket,
  removeItem as oreillyRemoveItem,
  updateQuantity as oreillyUpdateQuantity,
  validateBasket as oreillyValidateBasket,
} from './oreillyCart.service.js';
import { AuthError, authenticateUser } from './auth.js';
import { createLogger } from '../log.js';

/**
 * What every supplier cart must be able to do.
 *
 * The routes below are supplier-agnostic: they parse and validate the request,
 * then hand off. Adding a third supplier means adding an entry here and nothing
 * else in this file.
 */
interface CartConnector {
  getCurrentBasket(): Promise<MusgraveBasket>;
  addProducts(items: readonly AddProductRequest[]): Promise<AddProductsResult>;
  updateQuantity(
    basketItemId: string,
    quantity: number,
    sku: string,
  ): Promise<MusgraveBasket>;
  removeItem(basketItemId: string): Promise<MusgraveBasket>;
  validateBasket(): Promise<BasketValidation>;
  /**
   * Musgrave's PATCH needs the product alongside the line id or it fails at the
   * supplier with a far less obvious message. O'Reilly addresses a line by its
   * `prodbasket_key` alone, so demanding a SKU there would reject valid calls.
   */
  requiresSkuOnUpdate: boolean;
}

const CONNECTORS: Record<string, CartConnector> = {
  musgrave: {
    getCurrentBasket,
    addProducts,
    updateQuantity,
    removeItem,
    validateBasket,
    requiresSkuOnUpdate: true,
  },
  oreilly: {
    getCurrentBasket: oreillyGetBasket,
    addProducts: oreillyAddProducts,
    updateQuantity: oreillyUpdateQuantity,
    removeItem: oreillyRemoveItem,
    validateBasket: oreillyValidateBasket,
    requiresSkuOnUpdate: false,
  },
};

const log = createLogger('cart-routes');

const CORS = {
  'Access-Control-Allow-Origin': process.env.APP_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  // See jobRoutes: without `Authorization` the browser drops the bearer token on
  // the preflight and every call arrives unauthenticated.
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
  return true;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

/**
 * A supplier failure is a 502, not a 500.
 *
 * The distinction is not cosmetic: 500 tells the buyer this app is broken,
 * while 502 says Musgrave did not answer. Only one of those is worth them
 * retrying, and only one is worth us paging about.
 */
function sendFailure(res: ServerResponse, error: unknown): true {
  const message = error instanceof Error ? error.message : String(error);
  log.error('Cart operation failed', { message });
  return sendJson(res, 502, { error: message });
}

/** Validated add request. Rejects rather than silently coercing. */
function parseAddItems(body: unknown): AddProductRequest[] {
  const raw = Array.isArray(body) ? body : (body as { items?: unknown }).items;
  if (!Array.isArray(raw)) {
    throw new Error('items[] is required');
  }

  return raw.map((entry, index) => {
    const item = entry as Partial<AddProductRequest>;
    const sku = String(item.sku ?? '').trim();
    if (!sku) throw new Error(`items[${index}].sku is required`);

    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`items[${index}].quantity must be a whole number of 1 or more`);
    }

    return {
      sku,
      quantity,
      ...(item.unit ? { unit: String(item.unit) } : {}),
      ...(item.name ? { name: String(item.name) } : {}),
    };
  });
}

/**
 * Handle everything under /api/cart. Returns false when the path is not ours,
 * so the caller can carry on matching.
 */
export async function handleCartRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!path.startsWith('/api/cart')) return false;

  if (method === 'OPTIONS') return sendJson(res, 204, {});

  // The cart spends real money at a real supplier. It was the least defensible
  // open route in the API and is now authenticated like the rest.
  try {
    await authenticateUser(req);
  } catch (error) {
    if (error instanceof AuthError) {
      return sendJson(res, error.status, { error: error.message });
    }
    log.error('Authentication failed unexpectedly', {
      message: error instanceof Error ? error.message : String(error),
    });
    return sendJson(res, 500, { error: 'Authentication failed' });
  }

  const segments = path.split('/').filter(Boolean); // api, cart, musgrave, items, :id
  const supplier = segments[2];

  if (!supplier) {
    return sendJson(res, 400, { error: 'A supplier is required: /api/cart/musgrave' });
  }

  const cart = CONNECTORS[supplier];

  if (!cart) {
    // Explicit, so the frontend gets a real answer instead of a 404 that looks
    // like a routing bug.
    return sendJson(res, 501, {
      error:
        `Cart integration is not implemented for "${supplier}" — ` +
        `available: ${Object.keys(CONNECTORS).join(', ')}`,
    });
  }

  const section = segments[3];
  const itemId = segments[4];

  try {
    // ---- The basket itself -------------------------------------------------
    if (method === 'GET' && !section) {
      return sendJson(res, 200, await cart.getCurrentBasket());
    }

    // ---- Add ---------------------------------------------------------------
    if (method === 'POST' && section === 'items') {
      let items: AddProductRequest[];
      try {
        items = parseAddItems(await readJson(req));
      } catch (error) {
        return sendJson(res, 400, {
          error: error instanceof Error ? error.message : 'Invalid request',
        });
      }

      return sendJson(res, 200, await cart.addProducts(items));
    }

    // ---- Quantity ----------------------------------------------------------
    if (method === 'PATCH' && section === 'items' && itemId) {
      const body = await readJson(req);
      const quantity = Number(body.quantity);
      const sku = String(body.sku ?? '').trim();

      if (!Number.isInteger(quantity) || quantity < 0) {
        return sendJson(res, 400, {
          error: 'quantity must be a whole number of 0 or more',
        });
      }
      if (!sku && cart.requiresSkuOnUpdate) {
        return sendJson(res, 400, { error: 'sku is required alongside the quantity' });
      }

      return sendJson(res, 200, await cart.updateQuantity(itemId, quantity, sku));
    }

    // ---- Remove ------------------------------------------------------------
    if (method === 'DELETE' && section === 'items' && itemId) {
      return sendJson(res, 200, await cart.removeItem(itemId));
    }

    // ---- Validate ----------------------------------------------------------
    if (method === 'POST' && section === 'validate') {
      return sendJson(res, 200, await cart.validateBasket());
    }

    return sendJson(res, 404, { error: `No cart route for ${method} ${path}` });
  } catch (error) {
    return sendFailure(res, error);
  }
}
