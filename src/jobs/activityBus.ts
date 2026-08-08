/**
 * The one channel both dashboards listen to.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * Two apps need to watch the same things happen, from opposite ends:
 *
 *   - an ADMIN wants to see every retailer's upload and search as it happens,
 *     across all jobs, without knowing a job id in advance;
 *   - a RETAILER wants to know when an admin has confirmed or removed one of
 *     their lines, on the job they already have open.
 *
 * The job registry could only ever answer the second half of the first question:
 * it emits per-job batches to whoever already knows the job id. There was no way
 * to say "tell me about everything", and no way at all for a decision made in
 * the admin API to reach a retailer's open stream.
 *
 * So publishers announce here and subscribers listen here, and neither imports
 * the other. `adminRoutes` does not know a retailer is watching; the SSE stream
 * does not know an admin exists.
 *
 * WHY A RING BUFFER
 *
 * An admin opening the product dashboard at 11am should not see an empty screen
 * because the last upload finished at 10:58. Recent events are replayed on
 * subscribe, so the page opens with context instead of a blank state that looks
 * like a bug.
 *
 * IN-PROCESS, LIKE THE REGISTRY. Both are the live view; Supabase is the durable
 * record. Moving to several processes means replacing this with a real broker
 * (Postgres LISTEN/NOTIFY, Redis) and nothing else changes, because publishers
 * and subscribers only ever touch these two functions.
 */

import { EventEmitter } from 'node:events';

import type { JobBatchEvent, JobSummary } from './processingJob.js';

export type ActivityEvent =
  | {
      type: 'job-created';
      at: string;
      jobId: string;
      userId?: string;
      userEmail?: string;
      fileName: string;
      storeName?: string;
      totalProducts: number;
    }
  | {
      type: 'job-batch';
      at: string;
      jobId: string;
      userId?: string;
      batch: JobBatchEvent;
    }
  | {
      type: 'job-finished';
      at: string;
      jobId: string;
      userId?: string;
      summary: JobSummary;
    }
  | {
      type: 'product-search';
      at: string;
      userId?: string;
      userEmail?: string;
      query: string;
      resultCount: number;
    }
  | {
      type: 'row-confirmed';
      at: string;
      jobId: string;
      row: number;
      product: string;
      supplier: string;
      supplierSku: string;
      supplierProduct?: string;
      by?: string;
    }
  | {
      type: 'row-removed';
      at: string;
      jobId: string;
      row: number;
      product?: string;
      reason?: string;
      by?: string;
    }
  | {
      type: 'row-restored';
      at: string;
      jobId: string;
      row: number;
      by?: string;
    };

/** Admin decisions on a line — the events a retailer's open stream forwards. */
export type RowDecisionEvent = Extract<
  ActivityEvent,
  { type: 'row-confirmed' | 'row-removed' | 'row-restored' }
>;

export function isRowDecision(event: ActivityEvent): event is RowDecisionEvent {
  return (
    event.type === 'row-confirmed' ||
    event.type === 'row-removed' ||
    event.type === 'row-restored'
  );
}

const CHANNEL = 'activity';

/**
 * How much history a newly-connected dashboard is caught up with.
 *
 * Bounded because this is memory in a long-running process and a busy 5000-row
 * job emits a batch every few seconds. Two hundred is a few minutes of real
 * activity, which is what "what just happened" actually means.
 */
const HISTORY_LIMIT = 200;

const emitter = new EventEmitter();
// A dashboard per admin, plus one per open retailer job, legitimately exceeds
// the default ten listeners.
emitter.setMaxListeners(0);

const history: ActivityEvent[] = [];

export function publish(event: ActivityEvent): void {
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  emitter.emit(CHANNEL, event);
}

/** Everything still in the buffer, oldest first. */
export function recentActivity(limit = HISTORY_LIMIT): ActivityEvent[] {
  return history.slice(-limit);
}

/** Listen to everything. Returns an unsubscribe function. */
export function subscribeToActivity(listener: (event: ActivityEvent) => void): () => void {
  emitter.on(CHANNEL, listener);
  return () => emitter.off(CHANNEL, listener);
}

/** Test seam. */
export function resetActivity(): void {
  history.length = 0;
  emitter.removeAllListeners(CHANNEL);
}
