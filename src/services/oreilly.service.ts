import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";

import { SearchCard, absoluteUrl, normalizeCard } from "../connectors/types.js";
import { nameAgreement } from "./matchConfidence.js";
import type { SupplierSearchHit } from "./supplierSearch.js";

interface OreillySession {
  client: ReturnType<typeof wrapper>;
  expiresAt: number;
}

let session: OreillySession | null = null;
/** In-flight login, so concurrent cold-start searches share one handshake. */
let sessionPromise: Promise<OreillySession> | null = null;

export const BASE_URL = "https://order.oreillyswholesale.com";

const LOGIN_URL = `${BASE_URL}/login.asp`;

const SEARCH_URL = `${BASE_URL}/products/gridlist.asp`;

async function loginOreilly() {
  const username = process.env.OREILLY_EMAIL;
  const password = process.env.OREILLY_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "O'Reilly credentials missing — set OREILLY_EMAIL and OREILLY_PASSWORD",
    );
  }

  const jar = new CookieJar();

  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 10,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    }),
  );

  const body = new URLSearchParams({
    username,
    password,
  });

  await client.post(LOGIN_URL, body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  return client;
}

/**
 * Discard the cached session so the next `ensureSession` logs in afresh.
 *
 * The TTL below is an ASSUMPTION about how long O'Reilly keeps a session, not
 * something the server tells us. A long crawl discovers the truth the only way
 * available — by being handed the login page mid-run — and needs a way to say
 * "this session is dead" rather than waiting out a timer that is already wrong.
 */
export function forgetSession(): void {
  session = null;
}

/**
 * The logged-in client, shared with the cart connector.
 *
 * Exported because O'Reilly's basket lives in the ASP session identified by
 * these cookies — a second jar would be a second, empty basket.
 */
export async function ensureSession(): Promise<OreillySession> {
  if (session && Date.now() < session.expiresAt) {
    return session;
  }

  // One login per cold start, even when several searches begin at once.
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const client = await loginOreilly();

      const fresh: OreillySession = {
        client,
        expiresAt: Date.now() + 30 * 60 * 1000,
      };

      session = fresh;

      return fresh;
    })().finally(() => {
      sessionPromise = null;
    });
  }

  return sessionPromise;
}

/** The form field the search text travels in. */
export const OREILLY_SEARCH_PARAM = "product_desc";

/** The product-listing endpoint every description search hits. */
export const OREILLY_SEARCH_URL = SEARCH_URL;

/**
 * The exact query parameters sent for `query`. Exported so the pipeline debugger
 * reports the real request rather than a second copy of this shape.
 */
export function buildOreillySearchParams(query: string): Record<string, string> {
  return { [OREILLY_SEARCH_PARAM]: query };
}

/** The full search URL for `query`, form-encoded as axios sends it. */
export function buildOreillySearchUrl(query: string): string {
  return `${SEARCH_URL}?${new URLSearchParams(buildOreillySearchParams(query))}`;
}

export async function searchOreilly(
  query: string,
  opts: { maxDetails?: number } = {},
): Promise<SupplierSearchHit[]> {
  const session = await ensureSession();

  const response = await session.client.get(SEARCH_URL, {
    params: buildOreillySearchParams(query),
  });

  const html = response.data as string;

  // Parse HTML here
  const $ = cheerio.load(html);

  const cards: SearchCard[] = [];

  $(".ProductBox").each((_, element) => {
    const product = $(element);

    const supplierSku =
      product.find('input[name="product_code"]').val()?.toString() ?? "";

    const name = product.find('a[href*="DetailsPortal"]').last().text().trim();

    const priceText = product
      .find(".PromoPrice, .Price, .StdPrice")
      .first()
      .text()
      .trim();
    const rrpText = product
      .find(".ProdDetails")
      .filter((_, el) => $(el).text().includes("RRP"))
      .text()
      .replace("RRP", "")
      .trim();

    const vatText = product
      .find(".ProdDetails")
      .filter((_, el) => $(el).text().includes("VAT"))
      .text()
      .replace("VAT", "")
      .trim();

    // const sizeText = product
    //   .find(".ProdDetails")
    //   .filter((_, el) => {
    //     const t = $(el).text();

    //     return t.includes("ml") || t.includes("L") || t.includes("x");
    //   })
    //   .first()
    //   .text()
    //   .trim();

    const href = product.find('a[href*="DetailsPortal"]').first().attr("href");

    const productUrl = href ? BASE_URL + href : undefined;

    // The image inside the product link first: a `.ProductBox` also contains
    // basket icons and spacers, and taking the first `<img>` in the box would
    // show one of those as the product about as often as not. Falling back to
    // any image is still better than none — a wrong thumbnail is visible and
    // reportable, a missing one just looks like the feature does not work.
    const imageUrl = absoluteUrl(
      product.find('a[href*="DetailsPortal"] img').first().attr("src") ??
        product.find("img").first().attr("src"),
      BASE_URL,
    );

    // const isPromo = product.find(".PromoPrice").length > 0;

    // if (supplierSku === "023459") {
    //   console.log(product.html());
    // }
    // console.log("SKU:", supplierSku);
    // console.log("StdPrice:", product.find(".StdPrice").text().trim());
    // console.log("PromoPrice:", product.find(".PromoPrice").text().trim());
    cards.push({
      supplierSku,
      name,

      priceText,
      priceIncludesVat: false,

      rrpText,
      vatText,

      productUrl,
      imageUrl,

      isPmp: false,
      isOwnBrand: false,
    });
  });

  // O'Reilly states the EAN and pack size only on the product page, so every card
  // costs an extra fetch. A description search returns 20+ cards and a batch order
  // walks 15+ products, so enrich only the most plausible candidates rather than
  // firing hundreds of sequential requests at a logged-in trade account.
  //
  // Un-enriched cards are still returned: they carry no pack, so they can never
  // pass the confidence gates, but keeping them means the runner-up margin used
  // for ambiguity detection reflects the real result set.
  const maxDetails = Math.max(0, opts.maxDetails ?? cards.length);
  const enrich = new Set(
    cards
      .map((card, index) => ({ index, score: nameAgreement(query, card.name) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, maxDetails)
      .map((c) => c.index),
  );

  const detailedCards: SearchCard[] = [];

  for (const [index, card] of cards.entries()) {
    if (!enrich.has(index) || !card.productUrl) {
      detailedCards.push(card);
      continue;
    }

    try {
      detailedCards.push({
        ...card,
        ...(await getProductDetails(card.productUrl)),
      });
    } catch {
      // One dead product page must not lose the rest of the results.
      detailedCards.push(card);
    }
  }

  const capturedAt = new Date().toISOString();

  // The raw card travels with the normalized records — `pickBestMatch` needs it.
  return detailedCards.map((card) => ({
    card,
    ...normalizeCard(card, {
      supplierId: "oreilly",
      unitGtin: card.eanText ?? "",
      capturedAt,
    }),
  }));
}

async function getProductDetails(url: string): Promise<Partial<SearchCard>> {
  const currentSession = await ensureSession();

  const response = await currentSession.client.get(url);

  // const html = response.data as string;
  // const index = html.indexOf("EAN Code");

  // console.log(
  //   html.substring(
  //     Math.max(0, index - 300),
  //     index + 500,
  //   )
  // );
  // console.log("Contains EAN Code:", html.includes("EAN Code"));
  // console.log("Contains Pack Qty:", html.includes("Pack Qty"));
  // console.log("Contains Size:", html.includes("Size"));

  // const eans = html.match(/\b\d{13}\b/g);
  // console.log("13-digit numbers:", eans);

  const $ = cheerio.load(response.data);

  //   if (url.includes("048698")) {
  //   console.log("hello", response.data);
  // }

  const eanText = $("li.StdPrice2")
    .filter((_, el) => $(el).text().trim() === "EAN Code")
    .parent()
    .find("li.StdCell")
    .first()
    .text()
    .trim();

  const unitsPerCase = Number(
    $("li.StdPrice2")
      .filter((_, el) => $(el).text().trim() === "Pack Qty")
      .parent()
      .find("li.StdCell")
      .first()
      .text()
      .trim(),
  );

  const size = $("li.StdPrice2")
    .filter((_, el) => $(el).text().trim() === "Size")
    .parent()
    .find("li.StdCell")
    .first()
    .text()
    .trim();

  const match = size.match(/^([\d.]+)\s*(ml|cl|l|lt|ltr|g|kg)/i);

  let unitSize = 0;
  let uom: SearchCard["uom"] = "ml";

  if (match) {
    unitSize = Number(match[1]);

    const rawUom = match[2]!.toLowerCase();

    if (rawUom === "cl") {
      unitSize *= 10;
      uom = "ml";
    } else {
      uom = rawUom as SearchCard["uom"];
    }
  }

  //   if (!unitsPerCase || !unitSize) {
  //   console.log("================================");
  //   console.log("Missing pack information");
  //   console.log("URL:", url);
  //   console.log("EAN:", eanText);
  //   console.log("Pack Qty:", unitsPerCase);
  //   console.log("Size:", size);
  // }

  return {
    eanText,

    // The supplier's own Size text ("330ml"), kept as well as the parsed
    // numbers. It was being read, used for the regex above, and then dropped —
    // so the product page showed a size the dashboard could not, and a card
    // whose size failed the regex (a format like "6 x 1.5L") showed nothing at
    // all despite the page stating it plainly.
    ...(size ? { sizeText: size } : {}),

    ...(unitsPerCase > 0 && unitSize > 0
      ? {
          unitsPerCase,
          unitSize,
          uom,
        }
      : {}),
  };
}
