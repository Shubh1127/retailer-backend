/**
 * HTTP surface for processing jobs.
 *
 *   POST /api/jobs               upload a file → { jobId, … }, processing starts
 *   GET  /api/jobs               job history, newest first
 *   GET  /api/jobs/:id           one job's summary
 *   GET  /api/jobs/:id/rows      everything accumulated so far (page reload)
 *   GET  /api/jobs/:id/events    Server-Sent Events — one message per batch
 *   POST /api/jobs/:id/cancel    stop a running job
 *   GET  /api/jobs/:id/report    CSV export of the job's rows
 *
 * THIS is where persistence gets wired in: `startJob` is handed `onBatch` and
 * `onFinish` that write to Supabase. Nothing else calls the repository, so a job
 * started any other way is deliberately in-memory only.
 *
 * Kept in its own module rather than added to `server.ts` because SSE needs to
 * hold the response open and write to it over minutes, which is the opposite of
 * every other handler there.
 *
 * Uploads arrive as base64 JSON rather than multipart. The server is plain
 * `node:http` with no body-parsing dependency, `importEposListing` already
 * accepts base64, and `/api/import/epos-listing` established the convention.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  jobs as registry,
  startJob,
  type JobBatchEvent,
  type JobOptions,
  type JobSummary,
} from './processingJob.js';
import {
  insertJob,
  isPersistenceEnabled,
  listJobs,
  loadJob,
  saveBatch,
  updateJob,
} from '../repositories/processingJob.repository.js';
import { loadJobRowOverrides } from '../repositories/adminOverride.repository.js';
import { jobEditLock } from '../services/adminRoutes.js';
import { checkAiService } from '../services/aiMatch.client.js';
import { AuthError, authenticateUser, type AuthUser } from '../services/auth.js';
import { isRowDecision, publish, subscribeToActivity } from './activityBus.js';
import { createLogger } from '../log.js';
import type {
  NeedsAttentionRow,
  ReadyToOrderRow,
} from '../services/dashboardPipeline.service.js';

const log = createLogger('job-routes');

const CORS = {
  'Access-Control-Allow-Origin': process.env.APP_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  // `Authorization` must be allowed or the browser strips the bearer token on
  // the preflight and every request arrives unauthenticated — which looks like
  // a broken login rather than a CORS problem.
  // `Last-Event-ID` is here because the client reads the SSE stream with fetch
  // rather than EventSource — EventSource cannot send an Authorization header,
  // and putting the token in the query string would write it into every access
  // log between here and the browser. Reading it by hand costs a reconnect loop
  // and keeps the credential where credentials belong.
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Last-Event-ID',
  'Access-Control-Expose-Headers': 'Content-Disposition',
};

/** Returns true so handlers can `return sendJson(...)` to mean "handled". */
function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(json);
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

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * The job's rows as one CSV: ready-to-order lines first, then the exception
 * list. One row per retailer product in both sections — the same invariant the
 * dashboard shows, so the file and the screen always agree.
 */
function buildReport(
  summary: JobSummary,
  ready: readonly ReadyToOrderRow[],
  attention: readonly NeedsAttentionRow[],
): string {
  const rows: unknown[][] = [
    ['RetailCompare job report'],
    ['Job', summary.jobId],
    ['File', summary.fileName],
    ['Store', summary.storeName ?? ''],
    ['Status', summary.status],
    ['Products', summary.totalProducts],
    ['Ready to order', summary.readyProducts],
    ['Needs attention', summary.needsAttentionProducts],
    [],
    ['READY TO ORDER'],
    [
      'Excel row',
      'Article code',
      'Requested product',
      'Selected product',
      'Supplier',
      'SKU',
      'Cases',
      'Ex-VAT case price',
      'Current cost',
      'Saving per case',
      'Saving status',
      'Added to cart',
    ],
  ];

  for (const row of ready) {
    rows.push([
      row.row,
      row.articleCode,
      row.product,
      row.detail.selected?.product ?? '',
      row.bestSupplierName,
      row.detail.selected?.sku ?? '',
      row.cases,
      row.price.toFixed(2),
      row.baselineCost !== undefined ? row.baselineCost.toFixed(2) : '',
      // Blank rather than a negative number: a dearer supplier is not a saving,
      // and a spreadsheet SUM over this column must not be inflated by one.
      row.savings !== undefined ? row.savings.toFixed(2) : '',
      row.savingsStatus,
      row.addedToCart,
    ]);
  }

  rows.push([], ['NEEDS ATTENTION'], [
    'Excel row',
    'Article code',
    'Requested product',
    'Status',
    'Reason',
    'Suggestion',
    'Failure codes',
  ]);

  for (const row of attention) {
    rows.push([
      row.row,
      row.articleCode,
      row.product,
      row.status,
      row.reason,
      row.suggestion,
      row.codes.join(' '),
    ]);
  }

  return toCsv(rows);
}

/**
 * Persistence hooks handed to every job started over HTTP.
 *
 * Both are best-effort inside the registry: a Supabase failure is logged and the
 * run continues, because losing the history is recoverable and losing 2000 live
 * searches is not.
 */
/**
 * Standing admin decisions for a job, or none.
 *
 * `loadJobRowOverrides` throws on a database error, which is right for the
 * admin tools that exist to manage overrides. It is wrong here: this is the
 * retailer's own results page, and their rows must still render when the
 * override lookup fails. A missing decision degrades the page; a thrown one
 * empties it.
 */
async function rowOverridesFor(jobId: string) {
  try {
    return await loadJobRowOverrides(jobId);
  } catch (error) {
    log.warn('Could not read admin decisions for this job', {
      jobId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function persistenceHooks(): Pick<JobOptions, 'onBatch' | 'onFinish'> {
  return {
    onBatch: async (event, processed) => {
      await saveBatch(event.jobId, event.readyToOrder, event.needsAttention, processed);
      const summary = registry.get(event.jobId);
      if (summary) await updateJob(summary);
    },
    onFinish: async (summary) => {
      await updateJob(summary);
    },
  };
}

/**
 * Stream a job's batches as Server-Sent Events.
 *
 * SSE rather than WebSockets: progress is strictly one-way, it survives proxies
 * as plain HTTP, and the browser reconnects on its own. `Last-Event-ID` is
 * honoured so a reconnect resumes at the next unseen batch instead of replaying
 * — or worse, skipping — rows.
 */
function streamJob(req: IncomingMessage, res: ServerResponse, jobId: string): void {
  const summary = registry.get(jobId);
  if (!summary) {
    sendJson(res, 404, { error: `Unknown job ${jobId}` });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx buffers text/event-stream by default, which defeats the point.
    'X-Accel-Buffering': 'no',
    ...CORS,
  });

  const lastEventId = Number(req.headers['last-event-id']);
  const replayFrom = Number.isFinite(lastEventId) ? lastEventId + 1 : 0;

  const write = (event: string, data: unknown, id?: number) => {
    if (res.writableEnded) return;
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Declared BEFORE subscribing. `subscribe` replays past batches synchronously,
  // so for an already-finished job the listener runs during the subscribe call
  // itself — and anything it touches must already be initialized.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  let unsubscribeDecisions: (() => void) | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    unsubscribeDecisions?.();
  };

  const finish = (payload: unknown) => {
    write('done', payload);
    cleanup();
    res.end();
  };

  req.on('close', cleanup);
  res.on('error', cleanup);

  write('status', summary);

  // Admin decisions on THIS job, pushed down the retailer's open stream.
  //
  // This is the half that makes the two dashboards one system: an admin
  // confirming a line in the admin app appears on the retailer's screen while
  // they are still looking at it, rather than the next time they reload.
  unsubscribeDecisions = subscribeToActivity((event) => {
    if (closed) return;
    if (!isRowDecision(event) || event.jobId !== jobId) return;
    write('override', event);
  });

  unsubscribe = registry.subscribe(
    jobId,
    (event: JobBatchEvent) => {
      if (closed) return;
      write('batch', event, event.batchIndex);
      if (!event.isComplete) return;

      // The final batch is emitted from INSIDE the processing loop, before the
      // summary's status is moved off 'running'. The event knows the true
      // terminal state, so it wins — otherwise the client's last word on the
      // job is "running" and the status never settles.
      const summary = registry.get(jobId);
      finish(
        summary
          ? {
              ...summary,
              status: event.status,
              processedProducts: event.processedProducts,
              progress: event.progress,
            }
          : event,
      );
    },
    { replayFrom },
  );

  // The replay above may already have finished the stream.
  if (closed) return;

  // A job that completed before this client connected, whose terminal batch the
  // replay did not cover (e.g. reconnect past the last batch id). Without this
  // the client would wait forever on a job that is already over.
  const current = registry.get(jobId);
  if (current && (current.status === 'completed' || current.status === 'failed')) {
    finish(current);
    return;
  }

  // Proxies drop idle connections. A comment line is a valid SSE no-op.
  heartbeat = setInterval(() => {
    if (res.writableEnded) return cleanup();
    res.write(': ping\n\n');
  }, 15_000);
}

/**
 * Handle a job route. Returns false when the path is not ours, so `server.ts`
 * can carry on to its own routes.
 */
export async function handleJobRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!path.startsWith('/api/jobs')) return false;

  // Preflight must answer BEFORE authentication — the browser sends it without
  // credentials by design, so requiring a token here would block every request.
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  // Every job route is authenticated. This used to be open on the grounds that
  // it "runs on a trusted network and only reads" — but it also accepts uploads,
  // and an anonymous caller has no identity to attach a job to, which is why
  // nobody could be listed, tracked or blocked.
  let user: AuthUser;
  try {
    user = await authenticateUser(req);
  } catch (error) {
    if (error instanceof AuthError) {
      return sendJson(res, error.status, { error: error.message });
    }
    log.error('Authentication failed unexpectedly', {
      error: error instanceof Error ? error.message : String(error),
    });
    return sendJson(res, 500, { error: 'Authentication failed' });
  }

  /**
   * May this caller see this job?
   *
   * Admins see everything — that is what the product dashboard is. A retailer
   * sees only what they uploaded. Jobs created before authentication existed
   * have no owner; they are treated as admin-only rather than as everyone's,
   * because the safe reading of "we do not know who owns this" is not "you do".
   */
  const maySee = (owner: string | undefined): boolean =>
    user.role === 'admin' || (owner !== undefined && owner === user.id);

  const rest = path.slice('/api/jobs'.length).replace(/^\//, '');
  const [jobId, action] = rest.split('/');

  try {
    // ---- POST /api/jobs — upload and start ------------------------------
    if (method === 'POST' && !jobId) {
      const body = await readJson(req);
      if (typeof body.fileBase64 !== 'string' || body.fileBase64.length === 0) {
        return sendJson(res, 400, { error: 'fileBase64 (.xls/.xlsx/.csv) is required' });
      }

      // Told up front, not discovered at row 1 of 2000.
      const ai = await checkAiService();

      const { summary } = startJob(
        registry,
        {
          fileBase64: body.fileBase64,
          fileName: typeof body.fileName === 'string' ? body.fileName : 'upload',
          ...(typeof body.defaultCases === 'number' ? { defaultCases: body.defaultCases } : {}),
          // From the verified token, never from the body — a client that could
          // name its own owner could upload as somebody else.
          userId: user.id,
        },
        {
          ...(typeof body.batchSize === 'number' ? { batchSize: body.batchSize } : {}),
          ...(typeof body.concurrency === 'number' ? { concurrency: body.concurrency } : {}),
          ...(typeof body.maxProducts === 'number' ? { maxProducts: body.maxProducts } : {}),
          ...persistenceHooks(),
        },
      );

      await insertJob(summary, user.id);

      // The admin product dashboard shows the upload the moment it starts, not
      // when the first batch lands — which on a 2000-row file is a minute later.
      publish({
        type: 'job-created',
        at: new Date().toISOString(),
        jobId: summary.jobId,
        userId: user.id,
        ...(user.email ? { userEmail: user.email } : {}),
        fileName: summary.fileName,
        ...(summary.storeName ? { storeName: summary.storeName } : {}),
        totalProducts: summary.totalProducts,
      });

      if (summary.totalProducts === 0) {
        log.warn('Uploaded file parsed to zero products', { jobId: summary.jobId });
      }

      return sendJson(res, 202, {
        ...summary,
        aiService: ai,
        persistence: isPersistenceEnabled() ? 'supabase' : 'memory-only',
        warning:
          summary.totalProducts === 0
            ? 'No products parsed. The file needs the EPOS "Article Order Listing" layout (a header row with Article and Description).'
            : undefined,
      });
    }

    // ---- GET /api/jobs — history ----------------------------------------
    if (method === 'GET' && !jobId) {
      // Supabase is the durable history; the registry only knows this process.
      const stored = await listJobs(50, user.role === 'admin' ? undefined : user.id);
      const live = registry.list().filter((job) => maySee(job.userId));
      const byId = new Map(stored.map((job) => [job.jobId, job]));
      for (const job of live) byId.set(job.jobId, job); // live wins — it is fresher
      return sendJson(res, 200, {
        jobs: [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        persistence: isPersistenceEnabled() ? 'supabase' : 'memory-only',
      });
    }

    if (!jobId) return sendJson(res, 404, { error: `No route for ${method} ${path}` });

    // ---- Ownership --------------------------------------------------------
    //
    // Resolved ONCE here, ahead of every per-job route, so a route added later
    // cannot forget it. The live registry is asked first because it is fresher
    // and cheaper; the stored job answers for anything this process did not run.
    //
    // A job the caller may not see is reported as 404, not 403. "Forbidden"
    // confirms the job exists, which is precisely the fact a retailer should not
    // be able to learn about another retailer's upload.
    const owner = registry.get(jobId)?.userId ?? (await loadJob(jobId))?.summary.userId;
    if (!maySee(owner)) {
      return sendJson(res, 404, { error: `Unknown job ${jobId}` });
    }

    // ---- GET /api/jobs/:id/events — SSE ---------------------------------
    if (method === 'GET' && action === 'events') {
      streamJob(req, res, jobId);
      return true;
    }

    // ---- GET /api/jobs/:id/rows — full state (page reload) --------------
    //
    // Includes the admin decisions standing on this job. They were previously
    // pushed ONLY down the live SSE stream, so a retailer saw a line get
    // settled if they happened to have the page open at that moment and never
    // otherwise — a reload showed the original verdict again, as though the
    // admin had done nothing.
    if (method === 'GET' && action === 'rows') {
      const overrides = await rowOverridesFor(jobId);

      // The retailer sees the same lock the admin does — not to stop them doing
      // anything, since they confirm nothing, but because it answers "is this
      // still being worked on". A closed job will never change again, and the
      // page can stop polling for a change that cannot arrive.
      const snapshot = registry.snapshot(jobId);
      if (snapshot) {
        return sendJson(res, 200, { ...snapshot, overrides, lock: jobEditLock(snapshot) });
      }

      const stored = await loadJob(jobId);
      if (!stored) return sendJson(res, 404, { error: `Unknown job ${jobId}` });
      return sendJson(res, 200, { ...stored, overrides, lock: jobEditLock(stored) });
    }

    // ---- GET /api/jobs/:id/report — CSV ---------------------------------
    if (method === 'GET' && action === 'report') {
      const snapshot = registry.snapshot(jobId);
      const source = snapshot ?? (await loadJob(jobId));
      if (!source) return sendJson(res, 404, { error: `Unknown job ${jobId}` });

      const csv = buildReport(source.summary, source.readyToOrder, source.needsAttention);
      const name = `retailcompare-${source.summary.fileName.replace(/\.[^.]+$/, '')}-${jobId.slice(0, 8)}.csv`;

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        ...CORS,
      });
      res.end(csv);
      return true;
    }

    // ---- POST /api/jobs/:id/cancel --------------------------------------
    if (method === 'POST' && action === 'cancel') {
      const cancelled = registry.cancel(jobId);
      return sendJson(res, cancelled ? 200 : 409, {
        jobId,
        cancelled,
        ...(cancelled ? {} : { error: 'Job is not running' }),
      });
    }

    // ---- GET /api/jobs/:id ----------------------------------------------
    if (method === 'GET' && !action) {
      const summary = registry.get(jobId);
      if (summary) return sendJson(res, 200, summary);

      const stored = await loadJob(jobId);
      if (!stored) return sendJson(res, 404, { error: `Unknown job ${jobId}` });
      return sendJson(res, 200, stored.summary);
    }

    return sendJson(res, 404, { error: `No route for ${method} ${path}` });
  } catch (error) {
    log.error('Job route failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });

    // An SSE stream or a CSV download has already written its headers. Writing
    // a 500 on top throws ERR_HTTP_HEADERS_SENT, which propagates out of the
    // request handler and takes the whole process down — one bad request would
    // kill every running job. Close the response instead, and report handled so
    // `server.ts` does not try to answer it either.
    if (res.headersSent) {
      res.end();
      return true;
    }

    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Job request failed',
    });
  }
}
