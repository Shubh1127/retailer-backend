/**
 * HTTP API over the tested compute core. Zero external dependencies (node:http)
 * so it runs anywhere Node runs. The request handler (`createApp`) is separated
 * from `listen` so tests can exercise it without binding a port in CI.
 *
 * Routes (all under /api):
 *   GET  /health                 → { ok, version, counts }
 *   GET  /suppliers              → Supplier[]
 *   PUT  /suppliers              → replace suppliers (body: Supplier[])
 *   GET  /catalog                → CanonicalProduct[]
 *   POST /import/supplier        → seed prices+matches from a supplier CSV export
 *   POST /import/order-list      → parse a product-list CSV → OrderRequestLine[]
 *   POST /orders/prepare         → EPOS listing → matched SKUs → per-supplier CSVs
 *   POST /allocate               → run the allocation split
 *   POST /reconcile              → cart read-back reconciliation
 *
 * Processing jobs (upload → batched processing → live progress) live in
 * `jobs/jobRoutes.ts` and are dispatched before the routes above.
 *
 * Supplier credentials are never accepted or stored here — auth stays on-device.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { searchMusgrave } from "./services/musgrave.service.js";
import { compareProducts } from "./services/compare.service.js";
import {
  exportMusgraveProducts,
  readPageParams,
  MlExportError,
} from "./services/mlExport.service.js";
import { prepareSupplierOrderFiles } from "./services/orderFile.service.js";
import { readFile as readFileFs } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import type { Store, OrderLine } from "./store.js";
import { buildDemoCatalog, simulateRefresh } from "./simulate.js";
import { pickBestMatch } from "./connectors/match.js";
import { importSupplierFile, type ColumnMapping } from "./ingest/import.js";
import { importOrderList, type OrderListMapping } from "./ingest/orderList.js";
import { importEposListing } from "./ingest/eposListing.js";
import {
  parseCatalogTable,
  importSupplierCatalog,
  catalogStats,
  type CatalogRow,
} from "./ingest/catalog.js";
import { buildFetchPlan, applyFetchResults } from "./refresh.js";
import { prepareLine, type PrepareContext } from "./allocation/offers.js";
import { allocate } from "./allocation/engine.js";
import { reconcileCart } from "./reconcile.js";
import { handleJobRoute } from "./jobs/jobRoutes.js";
import { handleCartRoute } from "./services/cartRoutes.js";
import { handleAdminRoute } from "./services/adminRoutes.js";
import { handleMeRoute } from "./services/meRoutes.js";
import { AuthError, authenticateUser } from "./services/auth.js";
import { publish } from "./jobs/activityBus.js";
import type { AllocationConfig, OrderRequestLine } from "./types.js";
import dotenv from "dotenv";

dotenv.config();

const VERSION = "0.1.0";

const DEFAULT_SUPPLIER_MAPPING: ColumnMapping = {
  supplierSku: "SKU",
  description: "Description",
  unitGtin: "EAN",
  unitsPerCase: "CaseQty",
  unitSize: "UnitSize",
  uom: "UOM",
  casePrice: "CasePrice",
  vatRate: "VatRate",
  isPromo: "Promo",
  promoEndDate: "PromoEnd",
  isPmp: "PMP",
  isOwnBrand: "OwnBrand",
  brand: "Brand",
};
const DEFAULT_ORDERLIST_MAPPING: OrderListMapping = {
  barcode: "Barcode",
  cases: "Cases",
  description: "Name",
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    // `Authorization` is not optional. The OPTIONS short-circuit below answers
    // every preflight, INCLUDING the admin API's, before the per-router
    // handlers run — so if this list omits a header the admin dashboard sends,
    // the browser refuses the real request and the failure surfaces as a bare
    // "Failed to fetch" with no clue that CORS was the cause.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(json);
}

/** Directory holding the built dashboard SPA (served at /). */
const WEBAPP_DIR =
  process.env.WEBAPP_DIR ?? new URL("../../webapp", import.meta.url).pathname;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json",
};
async function serveStatic(
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  let rel = decodeURIComponent(urlPath.split("?")[0]!);
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = normalize(join(WEBAPP_DIR, rel));
  if (!full.startsWith(normalize(WEBAPP_DIR))) return false; // path traversal guard
  try {
    const data = await readFileFs(full);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full)] ?? "application/octet-stream",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

/** Everything the dashboard needs in one call. */
function fullState(store: Store) {
  const latest = new Map(
    store.quotes.map((q) => [`${q.supplierId}:${q.supplierSku}`, q]),
  );
  return {
    mode: store.mode,
    suppliers: store.suppliers,
    products: store.products,
    orderLines: store.orderLines,
    counts: {
      suppliers: store.suppliers.length,
      products: store.products.length,
      matches: store.matches.length,
      quotes: store.quotes.length,
      orderLines: store.orderLines.length,
      mapped: store.orderLines.filter((l) =>
        store.matches.some((m) => m.unitGtin === l.unitGtin),
      ).length,
    },
    // matches joined with product name + latest price for the cockpit
    matches: store.matches.map((m) => ({
      ...m,
      productName:
        store.products.find((p) => p.unitGtin === m.unitGtin)?.name ?? "",
      latestPrice:
        latest.get(`${m.supplierId}:${m.supplierSku}`)?.rawCasePrice ?? null,
    })),
  };
}

function todayIso(): string {
  // Server-side date is fine here (this is not a Workflow script).
  return new Date().toISOString().slice(0, 10);
}

/** Build the allocation for a list of lines against the current store state. */
export function runAllocation(
  store: Store,
  lines: OrderRequestLine[],
  opts: {
    pins?: Record<string, string>;
    preferenceBand?: number;
    orderDate?: string;
    outlierDeviation?: number;
  },
) {
  const config: AllocationConfig = {
    preferenceBand: opts.preferenceBand ?? 0.05,
    orderDate: opts.orderDate ?? todayIso(),
    outlierDeviation: opts.outlierDeviation ?? 0.45,
  };
  const ctx: Omit<PrepareContext, "suppliers"> = {
    matches: store.matches,
    quotes: store.quotes,
    products: new Map(store.products.map((p) => [p.unitGtin, p])),
    config,
    ...(opts.pins ? { pins: new Map(Object.entries(opts.pins)) } : {}),
  };
  const supMap = new Map(store.suppliers.map((s) => [s.id, s]));
  const inputs = lines.map((l) =>
    prepareLine(l, { ...ctx, suppliers: supMap }),
  );
  return allocate(inputs, store.suppliers, config);
}

/** Create the request handler bound to a store. */
export function createApp(store: Store) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";
      console.log("================================");
      console.log("Incoming Request");
      console.log("Method :", method);
      console.log("URL    :", req.url);
      console.log("Path   :", path);
      console.log("Origin :", req.headers.origin);
      console.log("Host   :", req.headers.host);
      console.log("================================");

      if (method === "OPTIONS") return send(res, 204, {});

      // Processing jobs own everything under /api/jobs. Handled first and in
      // their own module because the SSE stream holds the response open for
      // minutes, which no other handler here does.
      if (await handleJobRoute(req, res, method, path)) return;

      // Supplier basket. Owns everything under /api/cart, and like the job
      // routes it answers with its own CORS headers, so it is dispatched here
      // rather than folded into the switch below.
      if (await handleCartRoute(req, res, method, path)) return;

      // Admin. Dispatched BEFORE the open routes below so that everything
      // under /api/admin passes the authentication gate — a route that has to
      // remember to authenticate is a route that eventually forgets.
      if (await handleAdminRoute(req, res, method, path)) return;

      // Session probe for both apps. Its own module so that "who am I" cannot
      // drift from the gate that enforces the answer.
      if (await handleMeRoute(req, res, method, path)) return;

      if (method === "GET" && path === "/api/health") {
        return send(res, 200, {
          ok: true,
          version: VERSION,
          counts: {
            suppliers: store.suppliers.length,
            products: store.products.length,
            matches: store.matches.length,
            quotes: store.quotes.length,
          },
        });
      }
      if (method === "GET" && path === "/api/suppliers")
        return send(res, 200, store.suppliers);
      if (method === "PUT" && path === "/api/suppliers") {
        const body = await readJson(req);
        if (!Array.isArray(body))
          throw new HttpError(400, "Expected an array of suppliers");
        await store.setSuppliers(body);
        return send(res, 200, store.suppliers);
      }
      // Edit one supplier's buying rules (preference rank / margin / min order /
      // delivery) from the dashboard. Only whitelisted fields are patchable.
      if (method === "PATCH" && path.startsWith("/api/suppliers/")) {
        const id = decodeURIComponent(path.slice("/api/suppliers/".length));
        const body = await readJson(req);
        const current = store.suppliers.find((s) => s.id === id);
        if (!current) throw new HttpError(404, `Unknown supplier ${id}`);
        const patch: Record<string, unknown> = {};
        for (const k of [
          "preferenceRank",
          "thresholdPct",
          "minOrderValue",
          "deliveryFee",
          "freeDeliveryThreshold",
          "isMain",
          "name",
        ] as const) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        // Keep isMain consistent with rank 1: whoever is rank 1 is the main supplier.
        const next = store.suppliers.map((s) =>
          s.id === id ? { ...s, ...patch } : s,
        );
        if (patch.preferenceRank === 1)
          next.forEach((s) => {
            s.isMain = s.id === id;
          });
        await store.setSuppliers(next);
        return send(res, 200, store.suppliers);
      }
      if (method === "GET" && path === "/api/catalog")
        return send(res, 200, store.products);

      if (method === "POST" && path === "/api/import/supplier") {
        const body = await readJson(req);
        if (!body.supplierId || typeof body.csv !== "string")
          throw new HttpError(400, "supplierId and csv are required");
        const result = importSupplierFile(body.csv, {
          supplierId: body.supplierId,
          mapping: body.mapping ?? DEFAULT_SUPPLIER_MAPPING,
          capturedAt: body.capturedAt ?? new Date().toISOString(),
          defaultVatRate: body.defaultVatRate ?? 0.23,
          pricesVatInclusive: body.pricesVatInclusive ?? false,
        });
        await store.mergeImport({
          products: result.products,
          matches: result.matches,
          quotes: result.quotes,
        });
        return send(res, 200, {
          imported: {
            products: result.products.length,
            matches: result.matches.length,
            quotes: result.quotes.length,
          },
          needsReview: result.needsReview,
          errors: result.errors,
        });
      }

      if (method === "POST" && path === "/api/import/order-list") {
        const body = await readJson(req);
        if (typeof body.csv !== "string")
          throw new HttpError(400, "csv is required");
        const result = importOrderList(
          body.csv,
          body.mapping ?? DEFAULT_ORDERLIST_MAPPING,
        );
        return send(res, 200, result);
      }

      if (method === "POST" && path === "/api/import/catalog") {
        // Supplier catalog harvest (Name/Size/SKU/EAN) → shared map with direct
        // URLs, no searching. Accepts either a markdown/CSV `table` string OR a
        // structured `rows` array (what a category-harvest extension POSTs).
        const body = await readJson(req);
        if (!body.supplierId)
          throw new HttpError(400, "supplierId is required");
        let rows: CatalogRow[];
        if (Array.isArray(body.rows)) {
          rows = body.rows.map((r: Record<string, string>) => ({
            name: r.name ?? "",
            size: r.size ?? "",
            sku: String(r.sku ?? ""),
            ean: String(r.ean ?? ""),
          }));
        } else if (typeof body.table === "string") {
          rows = parseCatalogTable(body.table);
        } else {
          throw new HttpError(
            400,
            "Provide `rows` (array) or `table` (string)",
          );
        }
        const result = importSupplierCatalog(rows, body.supplierId);
        await store.mergeImport({
          products: result.products,
          matches: result.matches,
        });
        return send(res, 200, {
          mapped: result.matches.length,
          products: result.products.length,
          skipped: result.skipped,
          coverage: catalogStats(store.matches),
        });
      }

      if (method === "GET" && path === "/api/catalog/stats") {
        return send(res, 200, catalogStats(store.matches));
      }

      if (method === "POST" && path === "/api/import/epos-listing") {
        // Accepts an EPOS "Article Order Listing" .xls/.xlsx as base64.
        const body = await readJson(req);
        if (typeof body.fileBase64 !== "string")
          throw new HttpError(400, "fileBase64 (xls/xlsx) is required");
        const result = importEposListing(body.fileBase64, {
          defaultCases: body.defaultCases,
        });
        return send(res, 200, {
          storeName: result.storeName,
          count: result.articles.length,
          articles: result.articles,
          skipped: result.skipped,
        });
      }

      // EPOS listing → search both suppliers → confident matches → per-supplier
      // order CSVs. Stops at CSV text: no upload, no cart, no automation.
      if (method === "POST" && path === "/api/orders/prepare") {
        const body = await readJson(req);
        if (typeof body.fileBase64 !== "string")
          throw new HttpError(400, "fileBase64 (xls/xlsx) is required");

        try {
          const result = await prepareSupplierOrderFiles(
            Buffer.from(body.fileBase64, "base64"),
            {
              ...(typeof body.defaultCases === "number"
                ? { defaultCases: body.defaultCases }
                : {}),
              ...(typeof body.minConfidence === "number"
                ? { minConfidence: body.minConfidence }
                : {}),
              ...(typeof body.orderDate === "string"
                ? { orderDate: body.orderDate }
                : {}),
              ...(typeof body.preferenceBand === "number"
                ? { preferenceBand: body.preferenceBand }
                : {}),
              ...(typeof body.maxArticles === "number"
                ? { maxArticles: body.maxArticles }
                : {}),
              ...(body.csvTemplates ? { csvTemplates: body.csvTemplates } : {}),
            },
          );
          return send(res, 200, result);
        } catch (error) {
          console.error("Order preparation failed:", error);
          throw new HttpError(
            500,
            error instanceof Error
              ? error.message
              : "Unable to prepare supplier order files",
          );
        }
      }

      if (method === "POST" && path === "/api/refresh/plan") {
        // "Fetch the real price for this moment": returns the pages the on-device
        // WebView must load — direct product URLs for mapped items (no search),
        // EAN-search URLs for unmapped ones (discovery).
        const body = await readJson(req);
        const plan = buildFetchPlan(
          store,
          Array.isArray(body.lines) ? body.lines : undefined,
          {
            maxQuoteAgeHours:
              typeof body.maxQuoteAgeHours === "number"
                ? body.maxQuoteAgeHours
                : undefined,
          },
        );
        return send(res, 200, plan);
      }

      if (method === "POST" && path === "/api/refresh/results") {
        // WebView hands back extracted cards; we normalize, upsert fresh quotes,
        // and return the "N price changes detected" diff vs the cache.
        const body = await readJson(req);
        if (!Array.isArray(body.results))
          throw new HttpError(400, "results[] is required");
        const summary = await applyFetchResults(
          store,
          body.results,
          body.capturedAt ?? new Date().toISOString(),
        );
        return send(res, 200, summary);
      }

      if (method === "POST" && path === "/api/allocate") {
        const body = await readJson(req);
        if (!Array.isArray(body.lines))
          throw new HttpError(400, "lines[] is required");
        const result = runAllocation(store, body.lines, {
          pins: body.pins,
          preferenceBand: body.preferenceBand,
          orderDate: body.orderDate,
          outlierDeviation: body.outlierDeviation,
        });
        return send(res, 200, result);
      }

      if (method === "POST" && path === "/api/reconcile") {
        const body = await readJson(req);
        if (!Array.isArray(body.intended) || !Array.isArray(body.cart))
          throw new HttpError(400, "intended[] and cart[] are required");
        return send(
          res,
          200,
          reconcileCart(body.intended, body.cart, {
            priceTolerance: body.priceTolerance,
          }),
        );
      }

      // ---- Dashboard routes ----
      if (method === "GET" && path === "/api/state")
        return send(res, 200, fullState(store));

      if (method === "POST" && path === "/api/mode") {
        const body = await readJson(req);
        if (body.mode !== "stealth" && body.mode !== "full")
          throw new HttpError(400, "mode must be 'stealth' or 'full'");
        await store.setMode(body.mode);
        return send(res, 200, { mode: store.mode });
      }

      // Seed a rich demo catalog from an EPOS listing (base64) — TEST MODE.
      if (method === "POST" && path === "/api/seed-demo") {
        const body = await readJson(req);
        if (typeof body.fileBase64 !== "string")
          throw new HttpError(400, "fileBase64 (xls/xlsx) is required");
        const buf = Buffer.from(body.fileBase64, "base64");
        const demo = buildDemoCatalog(buf, {
          capturedAt: new Date().toISOString(),
          maxArticles: body.maxArticles,
        });
        await store.replaceCatalog({
          products: demo.products,
          matches: demo.matches,
          quotes: demo.quotes,
        });
        await store.setShopArticles(demo.articles);
        await store.setOrderLines(demo.orderLines);
        return send(res, 200, {
          products: demo.products.length,
          matches: demo.matches.length,
          orderLines: demo.orderLines.length,
        });
      }

      // One-click demo: seed from the bundled sample EPOS fixture (TEST MODE).
      if (method === "POST" && path === "/api/seed-demo-sample") {
        const body = await readJson(req).catch(() => ({}));
        const fixture = new URL(
          "../test/fixtures/epos-sample.xls",
          import.meta.url,
        ).pathname;
        const buf = await readFileFs(fixture);
        const demo = buildDemoCatalog(buf, {
          capturedAt: new Date().toISOString(),
          maxArticles: body?.maxArticles ?? 60,
        });
        await store.replaceCatalog({
          products: demo.products,
          matches: demo.matches,
          quotes: demo.quotes,
        });
        await store.setShopArticles(demo.articles);
        await store.setOrderLines(demo.orderLines);
        return send(res, 200, {
          products: demo.products.length,
          matches: demo.matches.length,
          orderLines: demo.orderLines.length,
        });
      }

      // Import a real EPOS listing → shop articles + order lines (auto-mapped by name).
      if (method === "POST" && path === "/api/import/epos") {
        const body = await readJson(req);
        if (typeof body.fileBase64 !== "string")
          throw new HttpError(400, "fileBase64 (xls/xlsx) is required");
        const result = importEposListing(
          Buffer.from(body.fileBase64, "base64"),
          { defaultCases: body.defaultCases },
        );
        await store.setShopArticles(result.articles);
        // Auto-map each article to an existing catalogue product by name (pack + name).
        const lines: OrderLine[] = result.articles.map((a) => {
          const cands = store.products.map((p) => ({
            supplierSku: "",
            name: p.name,
            unitsPerCase: a.unitsPerCase,
            unitSize: a.unitSize,
            priceText: "",
            _gtin: p.unitGtin,
          }));
          const d = pickBestMatch(
            {
              description: a.description,
              ...(a.unitsPerCase ? { unitsPerCase: a.unitsPerCase } : {}),
              ...(a.unitSize ? { unitSize: a.unitSize } : {}),
            },
            cands as never,
          );
          const gtin =
            d.best && !d.needsConfirm
              ? ((d.best.card as { _gtin?: string })._gtin ?? "")
              : "";
          return {
            articleCode: a.articleCode,
            unitGtin: gtin,
            description: a.description,
            packRaw: a.packRaw,
            cases: a.cases,
            ...(a.mainCost !== undefined ? { mainCost: a.mainCost } : {}),
          };
        });
        await store.setOrderLines(lines);
        return send(res, 200, {
          storeName: result.storeName,
          articles: result.articles.length,
          mapped: lines.filter((l) => l.unitGtin).length,
        });
      }

      // Run a (simulated) price refresh over the current catalogue.
      if (method === "POST" && path === "/api/refresh/run") {
        const capturedAt = new Date().toISOString();
        const { updated, changes } = simulateRefresh(store, capturedAt);
        await store.replaceQuotes(updated);
        await store.appendPriceHistory(
          changes.map((c) => ({
            supplierId: c.supplierId,
            supplierSku: c.supplierSku,
            rawCasePrice: c.newCasePrice,
            priceIsVatInclusive: false,
            vatRate: 0,
            isPromo: false,
            capturedAt,
            changePct: c.changePct,
          })),
        );
        return send(res, 200, {
          simulated: true,
          updated: updated.length,
          priceChanges: changes,
        });
      }

      // Compare + allocate the current order list.
      if (method === "POST" && path === "/api/compare") {
        const body = await readJson(req).catch(() => ({}));
        const lines: OrderRequestLine[] = store.orderLines
          .filter((l) => l.unitGtin)
          .map((l) => ({ unitGtin: l.unitGtin, cases: l.cases }));
        const result = runAllocation(store, lines, {
          preferenceBand: body?.preferenceBand,
          orderDate: body?.orderDate,
        });
        // decorate with names + main cost for the grid
        const byGtin = new Map(store.orderLines.map((l) => [l.unitGtin, l]));
        return send(res, 200, {
          ...result,
          lines: result.lines.map((ln) => ({
            ...ln,
            description: byGtin.get(ln.unitGtin)?.description ?? ln.unitGtin,
            mainCost: byGtin.get(ln.unitGtin)?.mainCost ?? null,
          })),
          mode: store.mode,
        });
      }

      // Mappings cockpit: patch / confirm / set-preferred / reverify.
      if (method === "PATCH" && path.startsWith("/api/matches/")) {
        const id = decodeURIComponent(path.slice("/api/matches/".length));
        const body = await readJson(req);
        const updated = await store.patchMatch(id, body);
        if (!updated) throw new HttpError(404, "match not found");
        return send(res, 200, updated);
      }
      if (
        method === "POST" &&
        /^\/api\/matches\/.+\/(confirm|set-preferred|reverify)$/.test(path)
      ) {
        const [, rawId, action] = path.match(
          /^\/api\/matches\/(.+)\/(confirm|set-preferred|reverify)$/,
        )!;
        const id = decodeURIComponent(rawId!);
        const patch =
          action === "confirm"
            ? {
                confirmed: true,
                provenance: "human_confirmed" as const,
                confidence: 1,
              }
            : action === "set-preferred"
              ? { isPreferred: true }
              : {
                  lastSuccessfulRefreshAt: new Date().toISOString(),
                  lastError: undefined,
                }; // reverify (simulated OK)
        const updated = await store.patchMatch(id, patch);
        if (!updated) throw new HttpError(404, "match not found");
        return send(res, 200, updated);
      }

      if (method === "GET" && path === "/api/price-history") {
        const sku = url.searchParams.get("sku");
        const rows = store.priceHistory.filter(
          (r) => !sku || r.supplierSku === sku,
        );
        return send(res, 200, rows.slice(-500));
      }

      if (method === "GET" && path === "/api/reports") {
        // Latest compare summary for the reports screen.
        const lines: OrderRequestLine[] = store.orderLines
          .filter((l) => l.unitGtin)
          .map((l) => ({ unitGtin: l.unitGtin, cases: l.cases }));
        const r = runAllocation(store, lines, {});
        return send(res, 200, {
          totalSavingExVat: r.totalSavingExVat,
          baselineAllFromMainExVat: r.baselineAllFromMainExVat,
          grandTotalExVat: r.grandTotalExVat,
          baskets: r.baskets,
          counts: r.counts,
          priceChangesLogged: store.priceHistory.length,
        });
      }

      if (method === "GET" && path === "/api/compare/search") {
        // The last retailer-facing route that was still open. It runs live
        // supplier searches against logged-in trade accounts, so leaving it
        // anonymous meant anyone who could reach the host could spend the
        // account's rate limit — and no search could be attributed to anybody.
        let searcher;
        try {
          searcher = await authenticateUser(req);
        } catch (error) {
          if (error instanceof AuthError) {
            throw new HttpError(error.status, error.message);
          }
          throw new HttpError(500, "Authentication failed");
        }

        const query = url.searchParams.get("q");

        if (!query) {
          throw new HttpError(400, "Missing search query");
        }

        try {
          const result = await compareProducts(query, {
            preferenceBand: 0.05,
            orderDate: todayIso(),
            outlierDeviation: 0.45,
          });

          // Surfaced on the admin product dashboard: what retailers are
          // searching for, and whether they are finding anything, is the other
          // half of "what is happening right now" beside the uploads.
          publish({
            type: "product-search",
            at: new Date().toISOString(),
            userId: searcher.id,
            ...(searcher.email ? { userEmail: searcher.email } : {}),
            query,
            resultCount: result.rows.length,
          });

          return send(res, 200, result);
        } catch (error) {
          console.error("Compare search failed:", error);

          throw new HttpError(500, "Unable to compare products");
        }
      }

      if (method === "GET" && path === "/api/suppliers/musgrave/search") {
        console.log("Musgrave search request received");

        const query = url.searchParams.get("q");

        console.log("Search query:", query);
        if (!query) {
          throw new HttpError(400, "Missing search query");
        }

        try {
          const products = await searchMusgrave(query);

          return send(res, 200, {
            supplier: "musgrave",
            count: products.length,
            products,
          });
        } catch (error) {
          console.error("Error during Musgrave search:", error);
          throw new HttpError(500, "Error during Musgrave search");
        }
      }

      // ---- Machine learning ----
      //
      // Training-data export, consumed ONLY by the Query Understanding dataset
      // builder. Read-only and paginated: the builder walks `nextOffset` until
      // it is null, so neither side ever holds the whole catalogue.
      if (method === "GET" && path === "/api/ml/musgrave-products") {
        try {
          const { limit, offset } = readPageParams(url.searchParams);
          return send(
            res,
            200,
            await exportMusgraveProducts({ limit, offset }),
          );
        } catch (error) {
          if (error instanceof MlExportError) {
            throw new HttpError(error.status, error.message);
          }
          throw error;
        }
      }

      // ---- Static SPA (anything not under /api) ----
      if (method === "GET" && !path.startsWith("/api/")) {
        if (await serveStatic(res, path)) return;
        // SPA fallback to index.html
        if (await serveStatic(res, "/index.html")) return;
      }

      return send(res, 404, { error: `No route for ${method} ${path}` });
    } catch (e) {
      if (e instanceof HttpError)
        return send(res, e.status, { error: e.message });
      return send(res, 500, {
        error: e instanceof Error ? e.message : "Internal error",
      });
    }
  };
}

/** Start listening (used by `npm run serve`). */
export async function startServer(
  store: Store,
  port = 8787,
): Promise<ReturnType<typeof createServer>> {
  const server = createServer(createApp(store));
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
