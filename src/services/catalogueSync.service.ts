/**
 * Running a catalogue sync from the admin dashboard.
 *
 * A sync takes the better part of an hour and makes thousands of requests to a
 * live trade account. Neither fact fits an HTTP request, so this owns the run
 * and the request only starts it:
 *
 *   POST  → start, return immediately with the run id
 *   GET   → where it has got to
 *
 * ONE AT A TIME, PER SUPPLIER.
 *
 * The single most damaging thing an admin could do from a button is start a
 * second crawl over the first: double the requests, against the supplier most
 * likely to respond by blocking the account. A second start is refused while
 * one is active — not queued, refused, so the caller is told rather than left
 * waiting on something they did not ask for.
 *
 * PROGRESS IS HELD IN MEMORY, NOT POLLED FROM THE DATABASE.
 *
 * The sync writes its counters to `oreilly_product_sync_runs` every few
 * seconds, which is what makes a completed run auditable. But the dashboard
 * reads from here, so a progress view never depends on a write having landed —
 * and stays correct in the seconds between them.
 *
 * A server restart ends any run in flight. That is acceptable precisely because
 * the sync is resumable: nothing is lost, and starting it again continues from
 * whatever has no detail page yet.
 */

import { syncOreillyProducts, type SyncProgress } from './oreillyProducts.sync.js';
import { createLogger } from '../log.js';

const log = createLogger('catalogue:sync');

export type CatalogueSupplier = 'oreilly';

export interface ActiveSync {
  supplier: CatalogueSupplier;
  startedAt: string;
  startedByEmail?: string;
  /** Listings only, or the full run including detail pages. */
  scope: 'full' | 'listings' | 'resume';
  progress?: SyncProgress;
}

export interface FinishedSync {
  supplier: CatalogueSupplier;
  startedAt: string;
  finishedAt: string;
  startedByEmail?: string;
  status: 'success' | 'partial' | 'failed';
  /** Set when the run threw rather than completing with failures inside it. */
  error?: string;
  progress?: SyncProgress;
}

const active = new Map<CatalogueSupplier, ActiveSync>();
/** The last run per supplier, so the dashboard says something before the first. */
const lastFinished = new Map<CatalogueSupplier, FinishedSync>();

export function activeSync(supplier: CatalogueSupplier): ActiveSync | undefined {
  return active.get(supplier);
}

export function lastSync(supplier: CatalogueSupplier): FinishedSync | undefined {
  return lastFinished.get(supplier);
}

export class SyncAlreadyRunningError extends Error {
  constructor(readonly supplier: CatalogueSupplier) {
    super(`A ${supplier} catalogue sync is already running.`);
    this.name = 'SyncAlreadyRunningError';
  }
}

export interface StartSyncOptions {
  supplier: CatalogueSupplier;
  scope?: 'full' | 'listings' | 'resume';
  startedByEmail?: string;
}

/**
 * Begin a sync and return once it has STARTED, not once it has finished.
 *
 * The promise resolves immediately; the crawl continues in the background. Any
 * error is captured into `lastFinished` rather than becoming an unhandled
 * rejection — a background failure must be visible in the dashboard, not only
 * in a log nobody is reading.
 */
export function startSync(options: StartSyncOptions): ActiveSync {
  const { supplier } = options;
  const scope = options.scope ?? 'full';

  const running = active.get(supplier);
  if (running) throw new SyncAlreadyRunningError(supplier);

  const entry: ActiveSync = {
    supplier,
    startedAt: new Date().toISOString(),
    scope,
    ...(options.startedByEmail ? { startedByEmail: options.startedByEmail } : {}),
  };

  active.set(supplier, entry);

  log.info('Catalogue sync started from the dashboard', {
    supplier,
    scope,
    by: options.startedByEmail ?? 'unknown',
  });

  void (async () => {
    try {
      const result = await syncOreillyProducts({
        skipDetails: scope === 'listings',
        skipListings: scope === 'resume',
        onProgress: (progress) => {
          // Mutate the live entry rather than replacing it, so a reader holding
          // the object sees the update.
          entry.progress = progress;
        },
      });

      lastFinished.set(supplier, {
        supplier,
        startedAt: entry.startedAt,
        finishedAt: new Date().toISOString(),
        status: result.status === 'running' ? 'partial' : result.status,
        ...(entry.startedByEmail ? { startedByEmail: entry.startedByEmail } : {}),
        ...(entry.progress ? { progress: entry.progress } : {}),
      });

      log.info('Catalogue sync finished', { supplier, status: result.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      lastFinished.set(supplier, {
        supplier,
        startedAt: entry.startedAt,
        finishedAt: new Date().toISOString(),
        status: 'failed',
        error: message,
        ...(entry.startedByEmail ? { startedByEmail: entry.startedByEmail } : {}),
        ...(entry.progress ? { progress: entry.progress } : {}),
      });

      log.error('Catalogue sync threw', { supplier, message });
    } finally {
      // Always cleared, or the button stays disabled until the next restart.
      active.delete(supplier);
    }
  })();

  return entry;
}
