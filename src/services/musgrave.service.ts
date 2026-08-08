import { SearchCard, absoluteUrl, normalizeCard } from "../connectors/types.js";
import type { SupplierSearchHit } from "./supplierSearch.js";

export interface MusgraveSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** The dynamic personalization group id. Used as `spgid` on every API path. */
  pgid: string;
}
interface MusgraveSearchResponse {
  elements: MusgraveProduct[];
}
interface MusgraveProduct {
  title: string;
  uri: string;
  attributes: {
    name: string;
    value: unknown;
  }[];
  attributeGroup?: {
    attributes: {
      name: string;
      value: unknown;
    }[];
  };
}

interface MoneyAttribute {
  type: "Money";
  value: number;
  currency: string;
  currencyMnemonic: string;
}

/** Shape of the OAuth token response from Musgrave's Intershop token endpoint. */
interface MusgraveAuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  // Catch-all for any additional fields Intershop returns.
  [key: string]: unknown;
}

/** Shape of the personalization response, which carries the pgid used to
 * scope subsequent product searches to this session. */
interface MusgravePersonalization {
  pgid: string;
  [key: string]: unknown;
}

let session: MusgraveSession | null = null;
/** In-flight login, so concurrent cold-start searches share one handshake. */
let sessionPromise: Promise<MusgraveSession> | null = null;

const TOKEN_URL =
  "https://www-api.musgravemarketplace.ie/INTERSHOP/rest/WFS/musgrave-MWPIRL-Site/-;loc=en_IE;cur=EUR/token";
// const MUSGRAVE_API_BASE =
//   "https://www-api.musgravemarketplace.ie/INTERSHOP/rest/WFS/musgrave-MWPIRL-Site/-;loc=en_IE;cur=EUR/products";

// const MUSGRAVE_API_BASE =
// "https://www-api.musgravemarketplace.ie/INTERSHOP/rest/WFS/musgrave-MWPIRL-Site/-;loc=en_IE;cur=EUR/products;spgid=GE4DVEybb4RuanUwquEN2aYE0000";

const MUSGRAVE_API_BASE =
  "https://www-api.musgravemarketplace.ie/INTERSHOP/rest/WFS/musgrave-MWPIRL-Site/-;loc=en_IE;cur=EUR/products";

const PERSONALIZATION_URL =
  "https://www-api.musgravemarketplace.ie/INTERSHOP/rest/WFS/musgrave-MWPIRL-Site/-;loc=en_IE;cur=EUR/personalization";

/** Site root every Musgrave REST resource hangs off (products, categories, …). */
/**
 * Where product images live.
 *
 * The API returns `image` as a path under /INTERSHOP/static/, and that path is
 * served by the API host — NOT by the storefront. The storefront answers 404
 * for the identical path, which is what made every Musgrave thumbnail render
 * as "No image" while the URL looked perfectly reasonable.
 *
 * Deliberately separate from the storefront base used for `productUrl`: a
 * product PAGE is on www, its image is on www-api, and collapsing the two
 * breaks one or the other.
 *
 * No session is needed — the images are public, so a browser can load them
 * directly.
 */
const MUSGRAVE_IMAGE_BASE = "https://www-api.musgravemarketplace.ie/";

export const MUSGRAVE_SITE_BASE =
  "https://www-api.musgravemarketplace.ie/INTERSHOP/rest/WFS/musgrave-MWPIRL-Site/-;loc=en_IE;cur=EUR";

export async function loginMusgrave(
  email: string,
  password: string
): Promise<MusgraveAuthResponse> {
    // console.log(email, password);
  const body = new URLSearchParams({
    grant_type: "password",
    username: email,
    password: password,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  //   console.log("Status:", response.status);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = (await response.json()) as MusgraveAuthResponse;
  //   console.log(data);

  return data;
}
// export async function searchMusgrave(query: string, accessToken: string) {
//   const params = new URLSearchParams({
//     searchTerm: query,
//     amount: "36",
//     offset: "0",
//     attrs:
//       "sku,salePrice,listPrice,availability,manufacturer,image,minOrderQuantity,inStock,promotions,packingUnit,productMasterSKU,estimatedDeliveryDate,supplier,taxRate,size,pricePerKilo,listPricePerKilo,isPromotionalPrice,UCIV,RRP,POR,DRSApplicable,DRSSingleQtyCharge",
//     labelAttributeGroup: "PRODUCT_LABEL_ATTRIBUTES",
//     attributeGroup: "PRODUCT_API_ATTRIBUTES",
//     returnSortKeys: "true",
//   });

//   const url = `${MUSGRAVE_API_BASE}?${params}`;

//   const response = await fetch(url, {
//     headers: {
//       "authentication-token": accessToken,
//       Accept: "application/json",
//     },
//   });

//   console.log("Search Status:", response.status);

//   const data = await response.json();

//   console.dir(data, { depth: null });

//   return data;
// }

async function ensureSession(): Promise<MusgraveSession> {
  if (session && Date.now() < session.expiresAt) {
    return session;
  }

  // Batch order preparation fires several searches at once. Without this guard
  // each concurrent cold-start search would trigger its own login.
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const email = process.env.MUSGRAVE_EMAIL;
      const password = process.env.MUSGRAVE_PASSWORD;

      if (!email || !password) {
        throw new Error(
          "Musgrave credentials missing — set MUSGRAVE_EMAIL and MUSGRAVE_PASSWORD",
        );
      }

      const auth = await loginMusgrave(email, password);

      const personalization = await getPersonalization(auth.access_token);

      const fresh: MusgraveSession = {
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token,
        expiresAt: Date.now() + auth.expires_in * 1000 - 60000,
        pgid: personalization.pgid,
      };

      session = fresh;

      return fresh;
    })().finally(() => {
      sessionPromise = null;
    });
  }

  return sessionPromise;
}

/**
 * The live authenticated session, logging in and running personalization first if
 * needed. `pgid` is the dynamic spgid every API path needs — callers must take it
 * from here rather than hardcoding one.
 */
export async function getMusgraveSession(): Promise<MusgraveSession> {
  return ensureSession();
}

export interface MusgraveApiResponse<T> {
  data: T;
  /** The exact URL requested, for logging and audit trails. */
  url: string;
  /** The spgid this call ran under. */
  spgid: string;
}

/**
 * Authenticated GET against a Musgrave REST resource.
 *
 * Handles the two things every Musgrave call needs: the `;spgid=` matrix
 * parameter taken from the current personalization session, and the
 * `authentication-token` header. `path` is relative to the site root, e.g.
 * "categories".
 */
/**
 * Build a Musgrave REST URL.
 *
 * `spgid` is NOT universal. Product and category resources need it; the BASKET
 * resources reject it — `/baskets;spgid=X/current` answers 404 while the plain
 * `/baskets/current` works. Verified against the Musgrave web client's own
 * network traffic, which sends no matrix parameter on any basket call.
 *
 * Where it IS used, Intershop attaches it to the RESOURCE segment, not to the
 * end of the path: "/categories;spgid=X/{id}/products", never
 * "/categories/{id}/products;spgid=X".
 */
function buildUrl(path: string, spgid: string | null, query: string): string {
  const [resource, ...rest] = path.split("/");
  const subPath = rest.length > 0 ? `/${rest.join("/")}` : "";
  const matrix = spgid ? `;spgid=${spgid}` : "";
  return `${MUSGRAVE_SITE_BASE}/${resource}${matrix}${subPath}${query ? `?${query}` : ""}`;
}

export interface MusgraveRequestOptions {
  /** Off for basket resources, which 404 when a matrix parameter is present. */
  useSpgid?: boolean;
  /**
   * Override the `Accept` header.
   *
   * Basket writes need Intershop's versioned media type
   * (`application/vnd.intershop.basket.v1+json`). Sending plain
   * `application/json` gets a 406 Not Acceptable, because the server has no
   * representation matching what was asked for.
   */
  accept?: string;
}

export async function musgraveApiGet<T>(
  path: string,
  query: Record<string, string> = {},
  options: MusgraveRequestOptions = {},
): Promise<MusgraveApiResponse<T>> {
  const session = await ensureSession();

  const params = new URLSearchParams(query).toString();
  const url = buildUrl(path, options.useSpgid === false ? null : session.pgid, params);

  const response = await fetch(url, {
    headers: {
      Accept: options.accept ?? "application/json",
      "authentication-token": session.accessToken,
    },
  });

  if (!response.ok) {
    throw new MusgraveApiError(response.status, `GET ${path}`, await response.text());
  }

  return {
    data: (await response.json()) as T,
    url,
    spgid: session.pgid,
  };
}

/** An error carrying the HTTP status, so callers can tell 404 from a real fault. */
export class MusgraveApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Musgrave ${path} failed (${status}): ${body.slice(0, 300)}`);
    this.name = "MusgraveApiError";
  }
}

/**
 * Authenticated POST / PATCH / DELETE against a Musgrave REST resource.
 *
 * The GET twin above cannot be reused: writes need a body, a method, and — for
 * the basket endpoints — bare valueless query flags like `msgSkipFulfillmentCheck`,
 * which `URLSearchParams` would render as `flag=` and Intershop rejects.
 *
 * The `;spgid=` matrix parameter goes on the RESOURCE segment, exactly as it
 * does for GET: "/baskets;spgid=X/current/items", never "/baskets/current/items;spgid=X".
 */
export async function musgraveApiSend<T>(
  method: "POST" | "PATCH" | "DELETE" | "PUT",
  path: string,
  body?: unknown,
  query: Record<string, string | null> = {},
  options: MusgraveRequestOptions = {},
): Promise<MusgraveApiResponse<T>> {
  const session = await ensureSession();

  // `null` means a bare flag with no `=value`. `msgSkipFulfillmentCheck` is
  // sent that way by Musgrave's own client, and `URLSearchParams` would render
  // it as `msgSkipFulfillmentCheck=`, which is a different request.
  const queryString = Object.entries(query)
    .map(([key, value]) =>
      value === null ? encodeURIComponent(key) : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");

  const url = buildUrl(path, options.useSpgid === false ? null : session.pgid, queryString);

  const response = await fetch(url, {
    method,
    headers: {
      Accept: options.accept ?? "application/json",
      "authentication-token": session.accessToken,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    throw new MusgraveApiError(response.status, `${method} ${path}`, await response.text());
  }

  // DELETE answers 204 with no body; parsing that would throw.
  const text = await response.text();

  return {
    data: (text ? JSON.parse(text) : undefined) as T,
    url,
    spgid: session.pgid,
  };
}

/** The request parameter the search text travels in. */
export const MUSGRAVE_SEARCH_PARAM = "searchTerm";

/**
 * The exact query string sent for `query`. Exported so the pipeline debugger can
 * report what a product search really transmits without re-deriving it here.
 */
export function buildMusgraveSearchParams(query: string): URLSearchParams {
  return new URLSearchParams({
    [MUSGRAVE_SEARCH_PARAM]: query,
    amount: "36",
    offset: "0",
    attrs:
      "sku,salePrice,listPrice,availability,manufacturer,image,minOrderQuantity,inStock,promotions,packingUnit,productMasterSKU,estimatedDeliveryDate,supplier,taxRate,size,pricePerKilo,listPricePerKilo,isPromotionalPrice,UCIV,RRP,POR,DRSApplicable,DRSSingleQtyCharge",
    labelAttributeGroup: "PRODUCT_LABEL_ATTRIBUTES",
    attributeGroup: "PRODUCT_API_ATTRIBUTES",
    returnSortKeys: "true",
  });
}

/** The full search URL for `query` under a given personalization group id. */
export function buildMusgraveSearchUrl(query: string, spgid: string): string {
  return `${MUSGRAVE_API_BASE};spgid=${spgid}?${buildMusgraveSearchParams(query)}`;
}

export async function searchMusgrave(query: string): Promise<SupplierSearchHit[]> {
  const session = await ensureSession();

  const url = buildMusgraveSearchUrl(query, session.pgid);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "authentication-token": session.accessToken,
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const json = (await response.json()) as MusgraveSearchResponse;

//   console.dir(json, { depth: null });


//   console.log("elements:", json.elements);
  const products = json.elements ?? [];

  const cards = products.map((product: MusgraveProduct) => toSearchCard(product));

  const capturedAt = new Date().toISOString();

  // The raw card travels with the normalized records: `normalizeCard` drops it,
  // but `pickBestMatch` needs it to disambiguate several results for one product.
  return cards.map((card) => ({
    card,
    ...normalizeCard(card, {
      supplierId: "musgrave",
      unitGtin: card.eanText ?? "",
      capturedAt,
    }),
  }));
}

export async function getPersonalization(
  accessToken: string
): Promise<MusgravePersonalization> {
  const response = await fetch(PERSONALIZATION_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "authentication-token": accessToken,
    },
  });

//   console.log("Personalization Status:", response.status);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = (await response.json()) as MusgravePersonalization;

//   console.dir(data, { depth: null });

  return data;
}

function getAttribute(product: MusgraveProduct, name: string) {
  return product.attributes?.find(
  (a: { name: string; value: unknown }) => a.name === name
)?.value;
}

function getGroupAttribute(product: MusgraveProduct, name: string) {
  return product.attributeGroup?.attributes?.find((a: { name: string; value: unknown }) => a.name === name)
    ?.value;
}

/** Narrows an attribute's `unknown` value down to a string, since
 * SearchCard's text fields require real strings, not `unknown`/`{}`. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Render a money attribute as display text.
 *
 * Musgrave states prices as `{ type: 'Money', value, currency }`, not as
 * numbers — see `MoneyAttribute`. Interpolating the attribute straight into a
 * template produced "€[object Object]" on the dashboard, because `getAttribute`
 * returns `unknown` and `${}` will happily stringify an object.
 *
 * Both shapes are accepted rather than just the object one: the attribute is
 * typed `unknown` precisely because Musgrave is free to change it, and a plain
 * number or a pre-formatted string should not start printing "[object Object]"
 * either.
 */
function asMoneyText(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? `€${value}` : undefined;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    return text.startsWith("€") ? text : `€${text}`;
  }

  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "number" && Number.isFinite(inner)) return `€${inner}`;
    if (typeof inner === "string" && inner.trim()) return `€${inner.trim()}`;
  }

  return undefined;
}

export function toSearchCard(product: MusgraveProduct): SearchCard {
  const salePrice = getAttribute(product, "salePrice")  as MoneyAttribute | undefined;
  const listPrice = getAttribute(product, "listPrice") as MoneyAttribute | undefined;

  return {
    supplierSku: asString(getAttribute(product, "sku")) ?? "",

    name: product.title ?? "",

    brand: asString(getAttribute(product, "manufacturer")),

    sizeText: asString(getAttribute(product, "size")),

    priceText:
      salePrice && typeof salePrice === "object"
        ? `€${salePrice.value}`
        : listPrice && typeof listPrice === "object"
          ? `€${listPrice.value}`
          : "",

    priceIncludesVat: false,

    rrpText: asMoneyText(getAttribute(product, "RRP")),

    vatText:
      getAttribute(product, "taxRate") != null
        ? `${Number(getAttribute(product, "taxRate")) * 100}%`
        : undefined,

    productUrl: product.uri
      ? `https://www.musgravemarketplace.ie/${product.uri}`
      : undefined,

    // `image` is already in the `attrs` this search requests, so it has been
    // arriving on every response and being dropped here. The API returns a
    // path, so it is resolved against the host that actually serves it.
    imageUrl: absoluteUrl(
      asString(getAttribute(product, "image")),
      MUSGRAVE_IMAGE_BASE,
    ),

    eanText: asString(getGroupAttribute(product, "EANCode")),

    isPmp: false,

    isOwnBrand: false,
  };
}