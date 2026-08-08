/**
 * Processing jobs — batched, streaming file processing.
 *
 *   upload → create job → return jobId → process in batches → emit each batch
 *
 * Why a job rather than a request/response
 * ----------------------------------------
 * A 2000-product file is 4000 live supplier searches. No HTTP request survives
 * that, and no retailer should stare at a spinner for it. The upload returns a
 * `jobId` immediately, processing continues in the background, and every
 * completed batch is emitted to whoever is listening. The retailer is making
 * purchasing decisions on the first 50 products while the rest are still
 * running.
 *
 * Incremental by contract
 * -----------------------
 * A batch event carries ONLY that batch's rows. The client appends; nothing is
 * resent. That is what keeps a 5000-product job the same cost per update as a
 * 50-product one, and it is why the frontend never needs to change as files
 * grow.
 *
 * One row, one product
 * --------------------
 * `processArticle` returns exactly one dashboard row per Excel article, so the
 * counters here are simply `ready + needsAttention === processed`. That is
 * asserted rather than assumed — see `recordRow`.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { importEposListing } from '../ingest/eposListing.js';
import { mapWithConcurrency } from '../services/supplierSearch.js';
import {
  processArticle,
  type NeedsAttentionRow,
  type ProcessArticleOptions,
  type ProcessedArticle,
  type ReadyToOrderRow,
} from '../services/dashboardPipeline.service.js';
import { publish } from './activityBus.js';
import { createLogger } from '../log.js';
import type { ShopArticle } from '../ingest/eposListing.js';

const log = createLogger('processing-job');

/** Products per emitted batch. The retailer sees results after this many. */
export const DEFAULT_BATCH_SIZE = 50;
/** Products searched at once. Low — these are logged-in trade accounts. */
export const DEFAULT_CONCURRENCY = 4;

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobSummary {
  jobId: string;
  fileName: string;
  /**
   * Who uploaded it. Present on every job created over HTTP now that the
   * retailer app authenticates — it is what lets a retailer be shown their own
   * uploads and only their own, while an admin sees every job.
   */
  userId?: string;
  storeName?: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  totalProducts: number;
  processedProducts: number;
  readyProducts: number;
  needsAttentionProducts: number;
  /** 0–100, rounded. */
  progress: number;
  error?: string;
}

/** What a client receives after each completed batch. */
export interface JobBatchEvent {
  jobId: string;
  batchIndex: number;
  processedProducts: number;
  totalProducts: number;
  progress: number;
  /** ONLY this batch's rows — the client appends. */
  readyToOrder: ReadyToOrderRow[];
  needsAttention: NeedsAttentionRow[];
  isComplete: boolean;
  status: JobStatus;
}

export interface JobOptions extends ProcessArticleOptions {
  batchSize?: number;
  concurrency?: number;
  /** Cap for testing / safety on very large files. */
  maxProducts?: number;
  /** Called after each batch is complete — used for Supabase persistence. */
  onBatch?: (event: JobBatchEvent, processed: ProcessedArticle[]) => Promise<void> | void;
  /** Called once when the job reaches a terminal state. */
  onFinish?: (summary: JobSummary) => Promise<void> | void;
}

interface JobRecord {
  summary: JobSummary;
  /** Accumulated rows, so a late subscriber can be caught up. */
  readyToOrder: ReadyToOrderRow[];
  needsAttention: NeedsAttentionRow[];
  /** Every batch emitted so far, for replay on reconnect. */
  batches: JobBatchEvent[];
  cancelled: boolean;
}

/**
 * In-process job registry.
 *
 * Deliberately in-memory and process-local: it is the live view, and Supabase is
 * the durable record (see `onBatch` / `onFinish`). Moving to a worker process or
 * a queue later replaces this class without touching the HTTP or client
 * contract, which is the point of routing everything through a jobId.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly emitter = new EventEmitter();

  constructor() {
    // A long file with many subscribers legitimately exceeds the default 10.
    this.emitter.setMaxListeners(0);
  }

  /** Create a job in `queued` state. Processing is started separately. */
  create(
    fileName: string,
    totalProducts: number,
    storeName?: string,
    userId?: string,
  ): JobSummary {
    const summary: JobSummary = {
      jobId: randomUUID(),
      fileName,
      status: 'queued',
      createdAt: new Date().toISOString(),
      totalProducts,
      processedProducts: 0,
      readyProducts: 0,
      needsAttentionProducts: 0,
      progress: 0,
      ...(storeName ? { storeName } : {}),
      ...(userId ? { userId } : {}),
    };

    this.jobs.set(summary.jobId, {
      summary,
      readyToOrder: [],
      needsAttention: [],
      batches: [],
      cancelled: false,
    });

    return summary;
  }

  get(jobId: string): JobSummary | undefined {
    return this.jobs.get(jobId)?.summary;
  }

  /** Newest first. */
  list(limit = 50): JobSummary[] {
    return [...this.jobs.values()]
      .map((record) => record.summary)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** Everything accumulated so far — used to catch up a late subscriber. */
  snapshot(jobId: string):
    | { summary: JobSummary; readyToOrder: ReadyToOrderRow[]; needsAttention: NeedsAttentionRow[] }
    | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    return {
      summary: record.summary,
      readyToOrder: record.readyToOrder,
      needsAttention: record.needsAttention,
    };
  }

  cancel(jobId: string): boolean {
    const record = this.jobs.get(jobId);
    if (!record || record.summary.status !== 'running') return false;
    record.cancelled = true;
    return true;
  }

  /**
   * Subscribe to a job's batch events. Returns an unsubscribe function.
   *
   * Batches already emitted are replayed first, so a client that connects late
   * — or reconnects after a dropped connection — still receives every row
   * exactly once and in order.
   */
  subscribe(
    jobId: string,
    listener: (event: JobBatchEvent) => void,
    opts: { replayFrom?: number } = {},
  ): () => void {
    const record = this.jobs.get(jobId);
    if (record) {
      const from = opts.replayFrom ?? 0;
      for (const batch of record.batches) {
        if (batch.batchIndex >= from) listener(batch);
      }
    }

    const channel = `batch:${jobId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  private emit(jobId: string, event: JobBatchEvent): void {
    const record = this.jobs.get(jobId);
    if (record) record.batches.push(event);
    this.emitter.emit(`batch:${jobId}`, event);

    // Announced to the whole system as well as to this job's subscribers, so an
    // admin watching the product dashboard sees every retailer's rows arrive
    // without having to know a job id first.
    publish({
      type: 'job-batch',
      at: new Date().toISOString(),
      jobId,
      ...(record?.summary.userId ? { userId: record.summary.userId } : {}),
      batch: event,
    });
  }

  /**
   * Process an uploaded file end to end.
   *
   * Runs to completion in the background; the caller does not await it. Every
   * failure mode — a bad file, a supplier outage, an AI outage — ends in a
   * terminal status with an emitted final event, never a silent hang.
   */
  async run(
    jobId: string,
    articles: readonly ShopArticle[],
    opts: JobOptions = {},
  ): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown job ${jobId}`);

    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

    record.summary.status = 'running';
    record.summary.startedAt = new Date().toISOString();

    log.info('Job started', { jobId, products: articles.length, batchSize, concurrency });

    try {
      for (let start = 0; start < articles.length; start += batchSize) {
        if (record.cancelled) {
          record.summary.status = 'cancelled';
          break;
        }

        const slice = articles.slice(start, start + batchSize);

        // Inside a batch, products run concurrently but the batch itself is a
        // barrier: the client is told "50 done" only when 50 really are.
        const processed = await mapWithConcurrency(slice, concurrency, (article) =>
          processArticle(article, opts),
        );

        const ready: ReadyToOrderRow[] = [];
        const attention: NeedsAttentionRow[] = [];

        for (const item of processed) {
          if (item.row.kind === 'ready') ready.push(item.row);
          else attention.push(item.row);
        }

        record.readyToOrder.push(...ready);
        record.needsAttention.push(...attention);
        record.summary.processedProducts += slice.length;
        record.summary.readyProducts += ready.length;
        record.summary.needsAttentionProducts += attention.length;
        record.summary.progress = Math.round(
          (record.summary.processedProducts / Math.max(1, record.summary.totalProducts)) * 100,
        );

        // The invariant this whole design rests on. If it ever breaks, the
        // dashboard silently gains or loses retailer products — fail loudly.
        if (ready.length + attention.length !== slice.length) {
          throw new Error(
            `Batch produced ${ready.length + attention.length} rows for ${slice.length} products`,
          );
        }

        const isComplete = record.summary.processedProducts >= articles.length;
        const event: JobBatchEvent = {
          jobId,
          batchIndex: Math.floor(start / batchSize),
          processedProducts: record.summary.processedProducts,
          totalProducts: record.summary.totalProducts,
          progress: record.summary.progress,
          readyToOrder: ready,
          needsAttention: attention,
          isComplete,
          status: isComplete ? 'completed' : 'running',
        };

        // Persist before emitting, so a client that acts on a row can rely on
        // it existing in the durable record.
        if (opts.onBatch) {
          try {
            await opts.onBatch(event, processed);
          } catch (error) {
            // Persistence is not allowed to kill a running job.
            log.warn('Batch persistence failed', {
              jobId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        this.emit(jobId, event);
      }

      if (record.summary.status === 'running') record.summary.status = 'completed';
    } catch (error) {
      record.summary.status = 'failed';
      record.summary.error = error instanceof Error ? error.message : String(error);
      log.error('Job failed', { jobId, error: record.summary.error });

      // A failed job must still tell its subscribers, or they wait forever.
      this.emit(jobId, {
        jobId,
        batchIndex: record.batches.length,
        processedProducts: record.summary.processedProducts,
        totalProducts: record.summary.totalProducts,
        progress: record.summary.progress,
        readyToOrder: [],
        needsAttention: [],
        isComplete: true,
        status: 'failed',
      });
    } finally {
      record.summary.completedAt = new Date().toISOString();
      if (opts.onFinish) {
        try {
          await opts.onFinish(record.summary);
        } catch (error) {
          log.warn('Job finalization failed', {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      publish({
        type: 'job-finished',
        at: new Date().toISOString(),
        jobId,
        ...(record.summary.userId ? { userId: record.summary.userId } : {}),
        summary: { ...record.summary },
      });

      log.info('Job finished', {
        jobId,
        status: record.summary.status,
        processed: record.summary.processedProducts,
        ready: record.summary.readyProducts,
        attention: record.summary.needsAttentionProducts,
      });
    }
  }
}

/** The process-wide registry the HTTP layer uses. */
export const jobs = new JobRegistry();

export interface StartJobInput {
  fileBase64: string;
  fileName: string;
  defaultCases?: number;
  /** The authenticated uploader. Set by the HTTP layer, never by the client. */
  userId?: string;
}

/**
 * Parse an uploaded file and start a job for it.
 *
 * Parsing is synchronous and fast, so it happens up front: the caller learns
 * immediately whether the file is readable and how many products it holds,
 * rather than discovering an unparseable file asynchronously.
 */
export function startJob(
  registry: JobRegistry,
  input: StartJobInput,
  opts: JobOptions = {},
): { summary: JobSummary; articles: ShopArticle[] } {
  const parsed = importEposListing(Buffer.from(input.fileBase64, 'base64'), {
    ...(input.defaultCases !== undefined ? { defaultCases: input.defaultCases } : {}),
  });

  const articles =
    opts.maxProducts !== undefined
      ? parsed.articles.slice(0, opts.maxProducts)
      : parsed.articles;

  const summary = registry.create(
    input.fileName,
    articles.length,
    parsed.storeName,
    input.userId,
  );

  // Deliberately not awaited: the HTTP response returns the jobId now and the
  // work continues. `run` never rejects, so this cannot become an unhandled
  // rejection.
  void registry.run(summary.jobId, articles, opts);

  return { summary, articles };
}
