# RetailCompare backend

The compute core. It parses a retailer's order file, searches every supplier,
matches each line to a product, verifies the match, and decides who to buy from.

Node 20+, TypeScript, **zero HTTP framework** — the server is `node:http`, so it
runs anywhere Node runs. Supplier credentials never leave this process.

---

## What it does

```
Excel (EPOS order listing)
   ↓  ingest/eposListing.ts        parse rows → ShopArticle
   ↓  normalization/               strip prices, flags, containers → canonical identity
   ↓  parsing/searchQuery.ts       build the retrieval ladder
       └── or POST /understand     the ML model, when QUERY_UNDERSTANDING=on
   ↓  services/*.service.ts        search Musgrave + O'Reilly, union + dedupe
   ↓  POST /match                  SBERT ranks the candidates
   ↓  services/ruleEngine.ts       deterministic rules judge each one
   ↓  commercialEquivalence.ts     settle "two listings, one product" on price
   ↓  productReconciliation        the safety gate — re-verify from scratch
   ↓  allocation/engine.ts         split the basket across suppliers on price
   ↓  Ready To Order / Needs Attention
```

**One Excel row produces exactly one dashboard row** — either Ready To Order or
Needs Attention, never both and never neither. That invariant is the reason
`dashboardPipeline.service.ts` exists.

### Features

| | |
| --- | --- |
| **Order file ingest** | EPOS `.xls`/`.xlsx` "Article Order Listing" → structured lines |
| **Product normalization** | Config-driven. Prices, `PMP`, `46P`, containers and forms move to metadata, not the bin |
| **Multi-supplier search** | Musgrave + O'Reilly concurrently; one supplier failing never loses the other |
| **Retrieval ladder** | Queries from most to least specific, unioned — supplier search is keyword-AND, so one bad token returns nothing |
| **Query Understanding** | Optional ML model replacing the rule ladder (`QUERY_UNDERSTANDING=on`) |
| **SBERT re-ranking** | External AI service. If it is down, the deterministic rules still run |
| **Rule engine** | Pack, unit size, container, form, multipack, ABV, variant — each pass/fail/unknown |
| **Commercial equivalence** | Strips retail decoration; where survivors are one product, takes the cheapest instead of asking a human |
| **Reconciliation** | Re-verifies the winner against the order line from scratch. Nothing upstream is taken on trust |
| **Allocation** | Lowest ex-VAT price wins; supplier preference only breaks ties |
| **Processing jobs** | Upload → batched processing → live SSE progress → persisted results |
| **Musgrave cart** | Push Ready To Order lines straight into the supplier basket |
| **Catalogue sync** | 38k Musgrave products into Supabase, for local matching and ML training |

---

## Quick start

```bash
cd backend
npm install
cp .env.example .env        # then fill it in — see below
npm run serve               # http://localhost:8787
```

Check it:

```bash
curl http://localhost:8787/api/health
```

`/api/health` probes its dependencies for real rather than reporting process
state, so it is the fastest way to tell a misconfigured server from a broken
one:

```jsonc
{
  "ok": true,                    // tracks the DATABASE only — see below
  "version": "0.1.0",
  "uptimeSeconds": 412,
  "database": {
    "reachable": true,
    "persistence": true,         // false when SUPABASE_* is unset:
                                 // jobs run but are never stored
    "rows": {                    // null (not 0) when a table can't be reached
      "musgrave_products": 38331,
      "oreilly_products": 5576,
      "processed_products": 1204
    }
  },
  "aiService": {
    "reachable": true,
    "status": "ok",
    "model": "all-MiniLM-L6-v2"
  }
}
```

Two things worth knowing about the contract:

- **It always answers `200`.** The API keeps serving without Supabase, so
  failing the HTTP status would pull a still-useful process out of a load
  balancer. `ok` carries the truth instead.
- **`ok` tracks the database, not the AI service.** A missing AI service
  degrades matching rather than stopping it — every similarity falls back to
  `0` and the deterministic rules still decide — so it is reported and cannot
  fail the check. If `aiService.reachable` is `false`, matches will still be
  produced, just worse.

The full pipeline also needs the **AI service** running (see `../ai-service`).
Without it, SBERT calls fail and the rules fall back to neutral similarity —
degraded, not broken.

---

## Environment

Create `backend/.env`. It is gitignored and must never be committed — it holds
live trade-account credentials.

### Required for supplier search

| Variable | Purpose |
| --- | --- |
| `MUSGRAVE_EMAIL` | Musgrave Marketplace login |
| `MUSGRAVE_PASSWORD` | |
| `OREILLY_EMAIL` | O'Reilly portal login |
| `OREILLY_PASSWORD` | |

### Required for persistence, catalogue sync and the cart

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service role** key. The `musgrave_*` tables have RLS enabled with no policies, so an anon key sees nothing. Server-side only — it bypasses RLS |

`SUPABASE_KEY` is accepted as a fallback name for the same value.

Without Supabase the server still runs: jobs are held in memory only, and
`/api/jobs` reports `persistence: "memory-only"`.

### Optional

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `AI_SERVICE_URL` | `http://127.0.0.1:8000` | SBERT **and** Query Understanding |
| `QUERY_UNDERSTANDING` | `off` | `on` routes query generation through the ML model |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `STORE_PATH` | `data/store.json` | Local JSON store |
| `WEBAPP_DIR` | `../../webapp` | Static SPA served at `/` |
| `NORMALIZATION_CONFIG_PATH` | `config/normalization.json` | Ship a different dictionary |
| `MATCHING_CONFIG_PATH` | `config/matching.json` | Thresholds and supplier preference |

Example:

```bash
MUSGRAVE_EMAIL=buyer@example.ie
MUSGRAVE_PASSWORD=…
OREILLY_EMAIL=buyer@example.ie
OREILLY_PASSWORD=…

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ…

AI_SERVICE_URL=http://127.0.0.1:8000
QUERY_UNDERSTANDING=on
LOG_LEVEL=info
```

---

## API

All routes are under `/api`. Everything answers JSON and sends permissive CORS
headers. Anything not under `/api` falls through to the static SPA.

### Processing jobs — the main flow

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/jobs` | Upload an order file (`fileBase64`, `fileName`) and start a job. Returns immediately with a `jobId` |
| `GET` | `/api/jobs` | Job history |
| `GET` | `/api/jobs/:id` | One job's summary and progress |
| `GET` | `/api/jobs/:id/events` | **SSE stream** — `status`, `batch`, `done` events as rows are produced |
| `GET` | `/api/jobs/:id/rows` | Everything accumulated so far. Used when reopening a finished job |
| `GET` | `/api/jobs/:id/report` | CSV export |
| `POST` | `/api/jobs/:id/cancel` | Stop a running job |

The frontend never processes a file — it uploads, gets a `jobId` and subscribes.
A 50-product file and a 5,000-product file are the same client code.

### Supplier cart (Musgrave)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/cart/musgrave` | The basket as Musgrave holds it, with line items and totals |
| `POST` | `/api/cart/musgrave/items` | Add products. Body `{ items: [{ sku, quantity, unit?, name? }] }` |
| `PATCH` | `/api/cart/musgrave/items/:basketItemId` | Set a quantity. Body `{ quantity, sku }` |
| `DELETE` | `/api/cart/musgrave/items/:basketItemId` | Remove a line |
| `POST` | `/api/cart/musgrave/validate` | Ask Musgrave to validate the basket |

Any other supplier answers `501` with an explicit message rather than a 404, so
a missing integration never looks like a routing bug. **The supplier basket is
the single source of truth** — every mutation returns the basket as it stands
afterwards, and nothing is cached.

### Comparison and allocation

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/compare/search?q=` | Search every supplier for one product and compare. **Authenticated** |
| `POST` | `/api/compare` | Compare + allocate the current order list |
| `POST` | `/api/allocate` | Run allocation over `lines[]` |
| `POST` | `/api/reconcile` | Cart read-back reconciliation |

### Import

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/import/supplier` | Seed prices + matches from a supplier CSV |
| `POST` | `/api/import/order-list` | Parse a product-list CSV |
| `POST` | `/api/orders/prepare` | EPOS file → matched SKUs → per-supplier order CSVs |

To upload an EPOS listing and actually process it, use `POST /api/jobs`
(see **Processing jobs** above) — that is the supported path.

### State, suppliers, catalogue

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Live dependency state + real row counts — see above |
| `GET` | `/api/state` | Everything the dashboard needs in one call |
| `GET` | `/api/catalog` | Canonical products |
| `GET` `PUT` | `/api/suppliers` | Read / replace suppliers |
| `PATCH` | `/api/suppliers/:id` | Edit buying rules (preference, margin, min order, delivery) |
| `POST` | `/api/refresh/plan` · `/api/refresh/results` | On-device price refresh |

### Machine learning

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ml/musgrave-products?limit=&offset=` | Paginated catalogue export. Consumed **only** by the Query Understanding dataset builder |

Walk `nextOffset` until it is `null`; neither side ever holds the whole
catalogue.

### Disabled routes

These twelve are commented out in `src/server.ts`. Each had **no caller
anywhere in the repository** — not the webapp, the admin dashboard, the iOS
app, the userscript, the prototype, or the test suite.

They are commented rather than deleted because several are the seam a future
feature would reattach to, and a commented block says "this existed and was
switched off" where a deletion says nothing at all. Each one's imports are
commented out beside it, so re-enabling means uncommenting two adjacent things.

| Path | Why it is off |
| --- | --- |
| `POST /api/import/catalog` | The manual route to a populated matching table, before the supplier syncs took that job |
| `GET /api/catalog/stats` | Coverage report for the above |
| `POST /api/import/epos-listing` | Superseded by `POST /api/jobs`, which parses the same `.xls` and then processes it |
| `POST /api/import/epos` | Auto-mapping EPOS import. Matched by name against the in-memory store using the *order-file* matcher, not the dashboard one |
| `POST /api/mode` | `stealth` \| `full` on the in-memory store |
| `POST /api/seed-demo` · `/api/seed-demo-sample` | TEST MODE by their own comments. They call `replaceCatalog`, not merge — one typo from overwriting a real catalogue with fixture data |
| `POST /api/refresh/run` | Simulated price movements |
| `PATCH /api/matches/:id` | Mappings cockpit. Wrote `store.matches` in memory, so a confirmation survived until the next restart |
| `POST /api/matches/:id/{confirm,set-preferred,reverify}` | Same. `reverify` never verified anything — it stamped a success timestamp unconditionally |
| `GET /api/price-history?sku=` | Read side of the in-memory price log |
| `GET /api/reports` | Allocation summary over the in-memory store |
| `GET /api/suppliers/musgrave/search?q=` | **Unauthenticated** live search against a logged-in trade account, while `/api/compare/search` beside it was deliberately gated. If you need it back, put it behind `authenticateUser` first — do not simply uncomment it |

Confirming a product mapping now happens through
`POST /api/admin/jobs/:jobId/rows/:row/confirm`, which writes `product_overrides`
in Supabase.

Everything the iOS app, the userscript and `test/server.test.ts` still call is
untouched: `/api/refresh/plan`, `/api/refresh/results`, `/api/allocate`,
`/api/catalog`, `/api/import/supplier`, `/api/import/order-list`,
`/api/reconcile`, `/api/state` and `/api/compare`.

---

## Scripts

```bash
npm run serve            # start the API
npm run build            # tsc → dist/
npm run typecheck        # tsc --noEmit
npm test                 # vitest (558 tests)
```

### Data and sync

```bash
npm run db:check              # verify the Supabase connection
npm run sync:categories       # Musgrave category tree → Supabase
npm run sync:products         # 38k Musgrave products → Supabase
```

### Diagnostics

Every one of these is read-only unless stated. They exist because a pipeline you
cannot inspect is a pipeline you cannot fix.

```bash
npm run debug:product         # one description through normalization + parsing
npm run debug:search          # what the supplier services actually receive
npm run test:sbert            # Excel → suppliers → SBERT → rules → reconciliation
npm run test:local-match      # match against the synced catalogue, no network
npm run compare:queries       # A/B the rule ladder vs the ML model on a real file
npm run analyse:rules         # which rule rejects each failing line
npm run prepare-order         # EPOS file → per-supplier order CSVs
```

Two scripts are **not** read-only and are not wired to npm:

- `src/scripts/testMusgraveCart.ts` — adds a product to the **live** basket,
  changes its quantity, then removes it. It restores state in a `finally`, but
  it does touch a real trade account.
- `src/scripts/probeSupplier.ts` — read-only, but hits the live supplier API.

---

## Layout

```
src/
  server.ts                 HTTP routing (node:http, no framework)
  main.ts                   entry point — DB check, then listen
  store.ts                  in-memory state + JSON persistence

  ingest/                   Excel and CSV parsing
  normalization/            config-driven product normalization
  parsing/                  tokenization, compound splitting, query ladder
  connectors/               supplier card shapes and normalization
  services/                 the pipeline — see below
  repositories/             Supabase reads and writes
  jobs/                     processing jobs + SSE
  allocation/               basket split across suppliers
  pricing/                  VAT normalization
  scripts/                  diagnostics and sync jobs

config/
  normalization.json        ALL product vocabulary. Data, never code
  matching.json             thresholds, supplier preference

test/                       vitest suites
test-data/                  real order files — gitignored, stays local
```

### Key services

| File | Role |
| --- | --- |
| `dashboardPipeline.service.ts` | Orchestrates one Excel row → one dashboard row |
| `supplierSearch.ts` | Search every supplier; isolate failures; concurrency helper |
| `musgrave.service.ts` · `oreilly.service.ts` | Supplier auth and search |
| `ruleEngine.ts` | Deterministic judgement of each candidate |
| `commercialEquivalence.ts` | "Two listings, one product" → take the cheapest |
| `productReconciliation.service.ts` | The final safety gate |
| `aiMatch.client.ts` | SBERT client. Failure ⇒ neutral similarity, never a lost line |
| `queryUnderstanding.client.ts` | ML query client. Failure ⇒ the rule ladder |
| `musgraveCart.service.ts` | **All** Musgrave basket REST |
| `mlExport.service.ts` | Catalogue export for training |

---

## Design rules worth knowing before changing anything

**No product knowledge in code.** Every brand, container, form and retail flag
lives in `config/normalization.json`. The system improves by growing a
dictionary, not by growing if-statements. If you find yourself adding a product
name to a `.ts` file, the change belongs in the config.

**One token, one category.** A word is a container *or* a form *or* a variant,
never two. `parsing/tokenCategory.ts` enforces it and warns on conflicts.
Letting a token mean different things in different products makes a wrong
categorisation unfalsifiable.

**Failure degrades, it never stops the run.** A supplier outage, an AI outage or
an unmatchable description all produce a Needs Attention row. In a 2,000-row job
one bad line must not cost the other 1,999.

**Retrieval favours recall, judgement favours precision.** The query ladder
deliberately over-retrieves; the rule engine and reconciliation throw the excess
away. A candidate the rules reject costs one comparison — a candidate retrieval
never returned cannot be recovered at all.

**Reconciliation trusts nothing.** It re-verifies the selected product against
the order line from scratch, including work the rule engine already did. It is
the last thing between a match and a retailer's money.

---

## Testing

```bash
npm test                      # 558 tests, 34 files
npx vitest run test/xyz.test.ts
```

Tests are offline — supplier search and the AI service are injected, so the
suite never touches a live account.
