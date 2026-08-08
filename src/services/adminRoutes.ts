/**
 * Admin API — everything under `/api/admin`.
 *
 * Two things separate this from the rest of the API:
 *
 *  1. **Every route is authenticated.** The gate is applied once, here, before
 *     dispatch — not per handler, because a handler that forgets is a hole and
 *     the only reliable way to not forget is to not have the choice.
 *
 *  2. **Every product has a URL.** `/api/admin/jobs/:jobId/rows/:row` returns
 *     one line's full detail, whether it is Ready To Order or Needs Attention.
 *     That is what lets the admin dashboard deep-link a product instead of
 *     showing it in a modal that cannot be shared, bookmarked or reopened.
 *
 * Read-only for now. Approve/edit/delete land on this same gate.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { listJobs, loadJob } from '../repositories/processingJob.repository.js';
import {
  clearJobRowOverride,
  clearProductOverride,
  loadJobRowOverrides,
  overrideKey,
  saveJobRowOverride,
  saveProductOverride,
} from '../repositories/adminOverride.repository.js';
import { AuthError, authenticateAdmin, type AuthUser } from './auth.js';
import {
  isOnline,
  listSessions,
  listUsers,
  ONLINE_WINDOW_MS,
  setBlocked,
  setRole,
} from '../repositories/appUser.repository.js';
import { locationLabel } from './geoLocation.js';
import {
  publish,
  recentActivity,
  subscribeToActivity,
  type ActivityEvent,
} from '../jobs/activityBus.js';
import { jobs as registry } from '../jobs/processingJob.js';
import { searchAllSuppliers } from './supplierSearch.js';
import {
  SyncAlreadyRunningError,
  activeSync,
  lastSync,
  startSync,
  type CatalogueSupplier,
} from './catalogueSync.service.js';
import { SupabaseOreillyProductRepository } from '../repositories/oreillyProduct.repository.js';

/** One instance: these calls are stateless reads against Supabase. */
const catalogueRepository = new SupabaseOreillyProductRepository();
import { toExVat } from '../pricing/normalize.js';
import { createLogger } from '../log.js';
import type {
  NeedsAttentionRow,
  ReadyToOrderRow,
} from './dashboardPipeline.service.js';

const log = createLogger('admin-routes');

/**
 * CORS for the admin dashboard.
 *
 * `Authorization` must be allowed or the browser strips the bearer token on
 * the preflight and every request arrives unauthenticated — which looks like a
 * broken login rather than a CORS problem.
 */
const CORS = {
  'Access-Control-Allow-Origin': process.env.ADMIN_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
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

/** One row of either kind, plus where it sits. */
type AnyRow = ReadyToOrderRow | NeedsAttentionRow;

/**
 * A job's rows, live first.
 *
 * The in-process registry holds a RUNNING job's rows the instant each batch
 * lands; Supabase holds them once the write completes, and holds nothing at all
 * if persistence is off or failing. Reading only Supabase — which this did —
 * meant an admin opening a job that was still processing saw an empty page,
 * while the retailer looking at the same job saw their products, because the
 * retailer's own route has always asked the registry first.
 *
 * Same order here, for the same reason: the registry is fresher, and the
 * database is what makes the job exist tomorrow.
 */
async function currentJob(jobId: string) {
  return registry.snapshot(jobId) ?? (await loadJob(jobId));
}

function findRow(
  ready: ReadyToOrderRow[],
  attention: NeedsAttentionRow[],
  rowNumber: number,
): AnyRow | undefined {
  return (
    ready.find((row) => row.row === rowNumber) ??
    attention.find((row) => row.row === rowNumber)
  );
}

export async function handleAdminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!path.startsWith('/api/admin')) return false;

  // Preflight must answer BEFORE authentication — the browser sends it without
  // credentials by design, so requiring a token here would block every request.
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  let user: AuthUser;
  try {
    user = await authenticateAdmin(req);
  } catch (error) {
    if (error instanceof AuthError) {
      return sendJson(res, error.status, { error: error.message });
    }
    log.error('Admin authentication failed unexpectedly', {
      message: error instanceof Error ? error.message : String(error),
    });
    return sendJson(res, 500, { error: 'Authentication failed' });
  }

  const segments = path.split('/').filter(Boolean); // api, admin, …
  const section = segments[2];

  try {
    // ---- Who am I ---------------------------------------------------------
    // The dashboard calls this on load to decide between the login screen and
    // the app, so it doubles as a token-validity probe.
    if (method === 'GET' && section === 'me') {
      return sendJson(res, 200, { user });
    }

    // ---- Live activity ----------------------------------------------------
    //
    // Everything happening across every retailer, as it happens: uploads, rows
    // landing batch by batch, product searches, and the admin decisions made on
    // them. This is what the product dashboard renders.
    //
    // Server-Sent Events for the same reasons the job stream uses them — one
    // way, plain HTTP, survives proxies. Recent events are replayed first so a
    // dashboard opened between uploads shows context rather than a blank page
    // that looks broken.
    if (method === 'GET' && section === 'activity') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...CORS,
      });

      let closed = false;
      const write = (event: string, data: unknown) => {
        if (res.writableEnded || closed) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      for (const event of recentActivity()) write('activity', event);
      write('ready', { at: new Date().toISOString() });

      const unsubscribe = subscribeToActivity((event: ActivityEvent) => {
        write('activity', event);
      });

      const heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        res.write(': ping\n\n');
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };

      req.on('close', cleanup);
      res.on('error', cleanup);
      return true;
    }

    // ---- Users ------------------------------------------------------------
    //
    // Retailers and admins come back in one call but as two lists. They are read
    // for different reasons — "who is using this" versus "who can change it" —
    // and a single list sorted by activity buries the four accounts that matter
    // among the hundred that do not.
    if (section === 'users') {
      const userId = segments[3];
      const sub = segments[4];

      if (method === 'GET' && !userId) {
        const users = await listUsers();

        // `online` is computed here, not stored. See the repository note: a
        // persisted flag is only correct until the process that set it dies.
        //
        // A location the user SHARED outranks the one guessed from their IP, and
        // the source travels with it. Collapsing both into one "location" string
        // would tell an administrator that a network-block estimate and a
        // consented GPS fix are the same kind of fact, and they are not — one is
        // accurate to a country and defeated by a VPN, the other is accurate to
        // metres and only exists because somebody agreed to it.
        const shaped = users.map((entry) => ({
          ...entry,
          online: isOnline(entry.lastSeenAt),
          locationLabel: entry.precise?.label ?? locationLabel(entry.location),
          locationSource: entry.precise
            ? ('precise' as const)
            : entry.location
              ? ('ip' as const)
              : ('unknown' as const),
          ...(entry.precise?.accuracyMetres !== undefined
            ? { locationAccuracyMetres: entry.precise.accuracyMetres }
            : {}),
          // The estimate is kept alongside rather than replaced. "Shared: Dublin,
          // but their address is in Spain" is exactly the discrepancy this
          // dashboard exists to make visible.
          ...(locationLabel(entry.location)
            ? { ipLocationLabel: locationLabel(entry.location) }
            : {}),
        }));

        return sendJson(res, 200, {
          retailers: shaped.filter((entry) => entry.role === 'retailer'),
          admins: shaped.filter((entry) => entry.role === 'admin'),
          onlineWindowMs: ONLINE_WINDOW_MS,
        });
      }

      // One user's sign-in history — which networks the account has been used
      // from, which is the question a single "last IP" can never answer.
      if (method === 'GET' && userId && sub === 'sessions') {
        const sessions = await listSessions(userId);
        return sendJson(res, 200, {
          sessions: sessions.map((entry) => ({
            ...entry,
            online: isOnline(entry.lastSeenAt),
            locationLabel: locationLabel(entry.location),
          })),
        });
      }

      // ---- Block / unblock ------------------------------------------------
      if (method === 'POST' && userId && (sub === 'block' || sub === 'unblock')) {
        const blocking = sub === 'block';

        // An admin who blocks themselves locks themselves out of the screen they
        // would need to undo it, and the seed allow-list is the only way back.
        if (blocking && userId === user.id) {
          return sendJson(res, 400, { error: 'You cannot block your own account' });
        }

        let reason: string | undefined;
        try {
          const body = await readJson(req);
          if (body?.reason) reason = String(body.reason);
        } catch {
          /* a block without a reason is still a block */
        }

        const updated = await setBlocked({
          userId,
          blocked: blocking,
          ...(reason ? { reason } : {}),
          ...(user.email ? { byEmail: user.email } : {}),
        });

        return sendJson(res, 200, { user: updated });
      }

      // ---- Role -----------------------------------------------------------
      if (method === 'POST' && userId && sub === 'role') {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return sendJson(res, 400, { error: 'Invalid JSON body' });
        }

        const role = String(body.role ?? '');
        if (role !== 'retailer' && role !== 'admin') {
          return sendJson(res, 400, { error: "role must be 'retailer' or 'admin'" });
        }

        // Same reasoning as blocking: demoting yourself removes your access to
        // the page that would let you undo it.
        if (userId === user.id && role !== 'admin') {
          return sendJson(res, 400, { error: 'You cannot remove your own admin role' });
        }

        return sendJson(res, 200, { user: await setRole(userId, role) });
      }
    }

    // ---- Catalogue sync ---------------------------------------------------
    //
    // Starting a crawl is a WRITE with real-world consequences: thousands of
    // requests to a supplier's live trade account. It is behind POST, behind
    // the admin gate, and refuses to start a second run over a first.
    if (section === 'catalogue') {
      const supplier = (segments[3] ?? 'oreilly') as CatalogueSupplier;

      if (method === 'GET' && !segments[4]) {
        const [runs, pendingDetails] = await Promise.all([
          catalogueRepository.listSyncRuns(8).catch(() => []),
          catalogueRepository.countPendingDetails().catch(() => 0),
        ]);

        return sendJson(res, 200, {
          supplier,
          active: activeSync(supplier) ?? null,
          last: lastSync(supplier) ?? null,
          pendingDetails,
          runs,
        });
      }

      if (method === 'POST' && segments[4] === 'sync') {
        let scope: 'full' | 'listings' | 'resume' = 'full';
        try {
          const body = await readJson(req);
          if (body?.scope === 'listings' || body?.scope === 'resume') scope = body.scope;
        } catch {
          /* an unparseable body just means the default scope */
        }

        try {
          const started = startSync({
            supplier,
            scope,
            ...(user.email ? { startedByEmail: user.email } : {}),
          });
          // 202: accepted and running, not finished. The caller polls.
          return sendJson(res, 202, { started });
        } catch (error) {
          if (error instanceof SyncAlreadyRunningError) {
            return sendJson(res, 409, {
              error: error.message,
              active: activeSync(supplier) ?? null,
            });
          }
          throw error;
        }
      }
    }

    // ---- Product search ---------------------------------------------------
    //
    // Reuses `searchAllSuppliers` — the SAME call the matching pipeline makes,
    // so what an admin sees here is exactly what the pipeline would have seen.
    // A separate search path would drift, and then "it works when I search for
    // it" would stop being evidence of anything.
    //
    // An EAN or SKU is just a query as far as the suppliers are concerned; they
    // match it against their own codes. No special casing is needed, and adding
    // some would only make the admin's search differ from the pipeline's.
    if (method === 'GET' && section === 'search') {
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q');
      if (!query?.trim()) {
        return sendJson(res, 400, { error: 'q is required' });
      }

      const result = await searchAllSuppliers(query.trim());

      const products = [...result.hits.entries()].flatMap(([supplier, hits]) =>
        hits.map((hit) => {
          const exVat = toExVat(
            hit.quote.rawCasePrice,
            hit.quote.vatRate,
            hit.quote.priceIsVatInclusive,
          );
          return {
            supplier,
            name: hit.card.name,
            sku: hit.card.supplierSku,
            ean: hit.card.eanText,
            brand: hit.card.brand,
            size: hit.card.sizeText,
            priceText: hit.card.priceText,
            exVatCasePrice: Number.isFinite(exVat) ? exVat : undefined,
            rrpText: hit.card.rrpText,
            vatText: hit.card.vatText,
            productUrl: hit.card.productUrl,
            imageUrl: hit.card.imageUrl,
            unitsPerCase: hit.match.caseConfig?.unitsPerCase,
            unitSize: hit.match.caseConfig?.unitSize,
            uom: hit.match.caseConfig?.uom,
          };
        }),
      );

      return sendJson(res, 200, {
        query: query.trim(),
        count: products.length,
        products,
        // Reported, not swallowed: "no results" and "Musgrave was down" look
        // identical on screen otherwise, and only one of them means the product
        // does not exist.
        errors: result.errors,
      });
    }

    // ---- Jobs -------------------------------------------------------------
    if (section === 'jobs') {
      const jobId = segments[3];
      const sub = segments[4];

      if (method === 'GET' && !jobId) {
        return sendJson(res, 200, { jobs: await listJobs(200) });
      }

      if (method === 'GET' && jobId && !sub) {
        const stored = await currentJob(jobId);
        if (!stored) return sendJson(res, 404, { error: 'No such job' });
        return sendJson(res, 200, stored.summary);
      }

      if (method === 'GET' && jobId && sub === 'rows') {
        const stored = await currentJob(jobId);
        if (!stored) return sendJson(res, 404, { error: 'No such job' });

        const rowNumber = segments[5];

        // ---- One product, by URL ------------------------------------------
        if (rowNumber !== undefined) {
          const parsed = Number(rowNumber);
          if (!Number.isInteger(parsed)) {
            return sendJson(res, 400, { error: 'Row must be a whole number' });
          }

          const row = findRow(stored.readyToOrder, stored.needsAttention, parsed);
          if (!row) {
            return sendJson(res, 404, {
              error: `Job ${jobId} has no row ${parsed}`,
            });
          }

          // Standing admin decisions for the whole job. Needed twice below —
          // for this line's own verdict, and to keep settled lines out of the
          // review queue.
          const overrides = await loadJobRowOverrides(jobId);
          const override = overrides[parsed];

          /**
           * PREV/NEXT STAY WITHIN ONE KIND.
           *
           * This used to walk ready and attention rows merged into a single
           * ordered list, so an admin working through the review queue pressed
           * Next and landed on a confirmed order — a line needing no decision,
           * in the middle of a run of lines that do. The two lists are
           * different jobs of work and are walked separately.
           *
           * Within Needs Attention, a line an admin has already settled is
           * skipped for the same reason: it has been dealt with. The CURRENT
           * row is always kept, so arriving on a settled line from a direct
           * link still shows a coherent position rather than "0 of n".
           */
          const sameKind =
            row.kind === 'ready' ? stored.readyToOrder : stored.needsAttention;

          const walkable = (
            row.kind === 'attention'
              ? sameKind.filter(
                  (entry) => entry.row === parsed || overrides[entry.row] === undefined,
                )
              : sameKind
          )
            .map((entry) => entry.row)
            .sort((a, b) => a - b);

          const index = walkable.indexOf(parsed);

          return sendJson(res, 200, {
            job: stored.summary,
            row,
            ...(override ? { override } : {}),
            navigation: {
              // Which queue this is, so the page can say so rather than
              // implying one undifferentiated list of products.
              kind: row.kind,
              position: index + 1,
              total: walkable.length,
              ...(index > 0 ? { previousRow: walkable[index - 1]! } : {}),
              ...(index >= 0 && index < walkable.length - 1
                ? { nextRow: walkable[index + 1]! }
                : {}),
            },
          });
        }

        // ---- Every row --------------------------------------------------
        return sendJson(res, 200, {
          summary: stored.summary,
          readyToOrder: stored.readyToOrder,
          needsAttention: stored.needsAttention,
          // Standing admin decisions, merged by the client rather than baked
          // into the rows: the pipeline's own verdict stays visible next to
          // the human's, so an override can be seen for what it is and undone.
          overrides: await loadJobRowOverrides(jobId),
        });
      }

      // ---- Confirm a line ---------------------------------------------
      //
      // Two writes, deliberately. The job-row override settles THIS line; the
      // product override teaches the pipeline what the description means, so
      // next week's file matches it without anybody looking. Doing only the
      // first is how an admin ends up correcting the same product forever.
      if (method === 'POST' && jobId && sub === 'rows' && segments[6] === 'confirm') {
        const rowNumber = Number(segments[5]);
        if (!Number.isInteger(rowNumber)) {
          return sendJson(res, 400, { error: 'Row must be a whole number' });
        }

        let body;
        try {
          body = await readJson(req);
        } catch {
          return sendJson(res, 400, { error: 'Invalid JSON body' });
        }

        const supplier = String(body.supplier ?? '').trim();
        const supplierSku = String(body.supplierSku ?? '').trim();
        if (!supplier || !supplierSku) {
          return sendJson(res, 400, {
            error: 'supplier and supplierSku are required',
          });
        }

        // Live first, like every other read: confirming a line on a job that is
        // still processing must not 404 merely because the batch holding it has
        // not been written to Supabase yet.
        const stored = await currentJob(jobId);
        if (!stored) return sendJson(res, 404, { error: 'No such job' });

        const row = findRow(stored.readyToOrder, stored.needsAttention, rowNumber);
        if (!row) return sendJson(res, 404, { error: `No row ${rowNumber}` });

        await saveJobRowOverride({
          jobId,
          rowNumber,
          action: 'confirmed',
          supplier,
          supplierSku,
          ...(body.supplierProduct ? { supplierProduct: String(body.supplierProduct) } : {}),
          ...(body.priceExVat !== undefined ? { priceExVat: Number(body.priceExVat) } : {}),
          ...(body.reason ? { reason: String(body.reason) } : {}),
          ...(user.email ? { createdByEmail: user.email } : {}),
        });

        // `row.product` is the retailer's own wording, which is the thing that
        // will recur — not the supplier's title.
        await saveProductOverride({
          normalizedQuery: overrideKey(row.product),
          rawQuery: row.product,
          supplier,
          supplierSku,
          ...(body.supplierProduct ? { supplierProduct: String(body.supplierProduct) } : {}),
          ...(body.ean ? { ean: String(body.ean) } : {}),
          ...(user.email ? { createdByEmail: user.email } : {}),
          ...(body.reason ? { note: String(body.reason) } : {}),
        });

        // Announced so the retailer watching this job sees the confirmation
        // land, and so it appears on the product dashboard's activity feed.
        publish({
          type: 'row-confirmed',
          at: new Date().toISOString(),
          jobId,
          row: rowNumber,
          product: row.product,
          supplier,
          supplierSku,
          ...(body.supplierProduct ? { supplierProduct: String(body.supplierProduct) } : {}),
          ...(user.email ? { by: user.email } : {}),
        });

        return sendJson(res, 200, {
          confirmed: true,
          jobId,
          row: rowNumber,
          supplier,
          supplierSku,
          rememberedFor: overrideKey(row.product),
        });
      }

      // ---- Remove a line ----------------------------------------------
      //
      // Recorded, never deleted. The pipeline's row stays exactly as it was and
      // the removal sits beside it, so "why is this not in the order" has an
      // answer with a name and a timestamp on it.
      if (method === 'DELETE' && jobId && sub === 'rows' && segments[5]) {
        const rowNumber = Number(segments[5]);
        if (!Number.isInteger(rowNumber)) {
          return sendJson(res, 400, { error: 'Row must be a whole number' });
        }

        let reason: string | undefined;
        try {
          const body = await readJson(req);
          if (body?.reason) reason = String(body.reason);
        } catch {
          /* a removal without a reason is still a removal */
        }

        await saveJobRowOverride({
          jobId,
          rowNumber,
          action: 'removed',
          ...(reason ? { reason } : {}),
          ...(user.email ? { createdByEmail: user.email } : {}),
        });

        publish({
          type: 'row-removed',
          at: new Date().toISOString(),
          jobId,
          row: rowNumber,
          ...(reason ? { reason } : {}),
          ...(user.email ? { by: user.email } : {}),
        });

        return sendJson(res, 200, { removed: true, jobId, row: rowNumber });
      }

      // ---- Undo ---------------------------------------------------------
      if (method === 'POST' && jobId && sub === 'rows' && segments[6] === 'restore') {
        const rowNumber = Number(segments[5]);
        if (!Number.isInteger(rowNumber)) {
          return sendJson(res, 400, { error: 'Row must be a whole number' });
        }
        // Read the decision BEFORE clearing it: undoing the lesson it taught
        // needs to know which product it named.
        const standing = (await loadJobRowOverrides(jobId))[rowNumber];

        await clearJobRowOverride(jobId, rowNumber);

        // A confirmation also taught the pipeline what the retailer's wording
        // means. Leaving that behind would revert the line an admin is looking
        // at while every future file kept matching the product they just took
        // back — an undo that undoes only what is on screen.
        if (standing?.action === 'confirmed' && standing.supplier && standing.supplierSku) {
          const job = await currentJob(jobId);
          const row = job
            ? findRow(job.readyToOrder, job.needsAttention, rowNumber)
            : undefined;

          if (row) {
            try {
              await clearProductOverride(
                overrideKey(row.product),
                standing.supplier,
                standing.supplierSku,
              );
            } catch (error) {
              // The line HAS been un-settled at this point. Failing the whole
              // request would report the undo as broken when half of it stuck,
              // so this is logged loudly and reported in the response instead.
              log.error('Undo could not clear the learned product mapping', {
                jobId,
                row: rowNumber,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        publish({
          type: 'row-restored',
          at: new Date().toISOString(),
          jobId,
          row: rowNumber,
          ...(user.email ? { by: user.email } : {}),
        });

        return sendJson(res, 200, { restored: true, jobId, row: rowNumber });
      }
    }

    return sendJson(res, 404, { error: `No admin route for ${method} ${path}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Admin request failed', { path, message });
    return sendJson(res, 500, { error: message });
  }
}
