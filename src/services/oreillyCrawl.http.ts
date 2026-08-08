/**
 * The one way the O'Reilly crawler talks to the supplier.
 *
 * Every request in the sync goes through `crawlGet`, so throttle detection,
 * backoff, re-authentication and per-request logging exist ONCE rather than at
 * each call site. A crawl is ~5,700 requests against a live trade account
 * behind Cloudflare; a code path that skips the guard is the one that gets the
 * account challenged.
 *
 * WHAT COUNTS AS "SLOW DOWN"
 *
 * Not just a status code. Measured against the live site, the failure modes are:
 *
 *   403 / 429 / 503     the usual rate-limit and challenge statuses
 *   cf-mitigated header Cloudflare stating outright that it acted
 *   challenge markup    arrives with a 200, and would otherwise be parsed as a
 *                       page containing no products — silently losing data
 *   the login form      also a 200; the ASP session lapsed mid-crawl, which is
 *                       expected, since the session TTL is shorter than the run
 *
 * The last two are why this cannot be a status-code check. A crawl that only
 * looked at `response.status` would record thousands of empty pages as success.
 *
 * WHAT IT DOES ABOUT IT
 *
 * A session lapse re-authenticates and retries — that is routine, not throttling.
 * Anything else trips the shared `ThrottleState`, which drops the whole crawl to
 * a single lane and pauses for a growing interval. Concurrency is deliberately
 * global rather than per-request: when a supplier pushes back, the answer is for
 * EVERYTHING to slow down, not for one worker to sleep while eight others keep
 * hammering.
 */

import type { AxiosResponse } from 'axios';

import { ensureSession, forgetSession } from './oreilly.service.js';
import { sleep } from './supplierSearch.js';
import { createLogger } from '../log.js';

const log = createLogger('oreilly:crawl:http');

/** Statuses that mean "you are asking too often", as opposed to "not found". */
const THROTTLE_STATUSES = new Set([403, 429, 503]);

/** Cloudflare interstitials arrive as 200s; these strings are what give them away. */
const CHALLENGE_MARKERS =
  /just a moment|attention required|challenge-platform|cf-error|_cf_chl|cf_chl_opt/i;

export interface CrawlRequestOutcome {
  html: string;
  status: number;
  attempts: number;
  /** True when this request had to re-authenticate before it succeeded. */
  reauthenticated: boolean;
  /** True when this request was throttled at least once. */
  throttled: boolean;
  durationMs: number;
}

/**
 * How defensive the crawl currently is, shared by every worker.
 *
 * Lives here rather than in the sync so that a throttle seen by one request
 * immediately governs the others. `lanes` is read by the enrichment pool
 * between items — it cannot cancel work already in flight, but it stops new
 * work from being started at the old rate.
 */
export class ThrottleState {
  /** Current concurrency. Drops to 1 on the first sign and recovers slowly. */
  lanes: number;
  readonly normalLanes: number;

  throttleEvents = 0;
  reauthEvents = 0;

  /** Consecutive clean requests, used to decide when it is safe to speed up. */
  private cleanRun = 0;
  /** Grows while throttling persists, so repeated pushback waits longer. */
  private backoffMs = 0;

  constructor(lanes: number) {
    this.normalLanes = lanes;
    this.lanes = lanes;
  }

  get isBackedOff(): boolean {
    return this.lanes < this.normalLanes;
  }

  /**
   * Record pushback and return how long to wait.
   *
   * Doubling from 5s, capped at 2 minutes: long enough for a token bucket to
   * refill, short enough that a 5,700-request crawl is not abandoned by a
   * transient blip.
   */
  noteThrottled(): number {
    this.throttleEvents += 1;
    this.cleanRun = 0;
    this.lanes = 1;
    this.backoffMs = this.backoffMs === 0 ? 5_000 : Math.min(this.backoffMs * 2, 120_000);
    return this.backoffMs;
  }

  noteReauthenticated(): void {
    this.reauthEvents += 1;
  }

  /**
   * Record a clean request, and recover one lane at a time.
   *
   * Recovery is gradual and never automatic: 50 consecutive clean requests buy
   * back a single lane. Jumping straight back to full concurrency after one
   * success is how a crawl oscillates between blocked and blocking.
   */
  noteClean(): void {
    if (!this.isBackedOff) return;

    this.cleanRun += 1;
    if (this.cleanRun < 50) return;

    this.cleanRun = 0;
    this.lanes = Math.min(this.lanes + 1, this.normalLanes);
    this.backoffMs = Math.max(0, this.backoffMs / 2);

    log.info('Recovering concurrency after a clean run', {
      lanes: this.lanes,
      normalLanes: this.normalLanes,
    });
  }
}

function looksLikeChallenge(html: string): boolean {
  // Only the head of the document: a product page can legitimately contain the
  // word "moment" in a description, but not in its first few kilobytes of
  // markup.
  return CHALLENGE_MARKERS.test(html.slice(0, 4_000));
}

function looksLikeLoginPage(html: string): boolean {
  return /name=["']password["']/i.test(html);
}

export interface CrawlGetOptions {
  /** Shown in the log line, e.g. "listing" or a product code. */
  label: string;
  /** Request counter for the progress prefix, e.g. "[132/5701]". */
  position?: number;
  total?: number;
  /** Extra context for the log line — department, product name, and so on. */
  context?: Record<string, unknown>;
  /** Attempts before giving up on this URL. */
  maxAttempts?: number;
  throttle: ThrottleState;
}

/**
 * Fetch one page, surviving what a long crawl actually runs into.
 *
 * Throws only when every attempt is exhausted — the caller decides whether one
 * dead product should end the run (it should not) or one dead listing page
 * should fail its department (it should).
 */
export async function crawlGet(
  url: string,
  options: CrawlGetOptions,
): Promise<CrawlRequestOutcome> {
  const maxAttempts = options.maxAttempts ?? 4;
  const startedAt = Date.now();

  let reauthenticated = false;
  let throttled = false;
  let lastProblem = 'unknown';

  const prefix =
    options.position !== undefined && options.total !== undefined
      ? `[${options.position}/${options.total}] `
      : '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = await ensureSession();
    const at = Date.now();

    const response: AxiosResponse = await session.client.get(url, {
      validateStatus: () => true,
    });

    const html = String(response.data ?? '');
    const ms = Date.now() - at;
    const mitigated = response.headers['cf-mitigated'];

    // ---- Session lapsed: routine on a run longer than the session TTL -----
    if (looksLikeLoginPage(html)) {
      lastProblem = 'login page — session expired';
      reauthenticated = true;
      options.throttle.noteReauthenticated();

      log.warn(`${prefix}${options.label} — session expired, re-authenticating`, {
        url,
        attempt,
        ...options.context,
      });

      // Discard the dead session so `ensureSession` cannot hand it back.
      forgetSession();
      await sleep(1_000);
      continue;
    }

    // ---- Pushback ---------------------------------------------------------
    const isThrottleStatus = THROTTLE_STATUSES.has(response.status);
    const isChallenge = looksLikeChallenge(html);

    if (isThrottleStatus || isChallenge || mitigated) {
      throttled = true;
      lastProblem = mitigated
        ? `cf-mitigated: ${mitigated}`
        : isChallenge
          ? 'Cloudflare challenge page'
          : `HTTP ${response.status}`;

      const waitMs = options.throttle.noteThrottled();

      log.warn(
        `${prefix}${options.label} — THROTTLED (${lastProblem}), ` +
          `backing off ${Math.round(waitMs / 1000)}s at 1 lane`,
        { url, status: response.status, attempt, ...options.context },
      );

      await sleep(waitMs);
      continue;
    }

    // ---- Any other non-200 ------------------------------------------------
    if (response.status !== 200) {
      lastProblem = `HTTP ${response.status}`;
      log.warn(`${prefix}${options.label} — ${lastProblem}, retrying`, {
        url,
        attempt,
        ...options.context,
      });
      await sleep(1_000 * attempt);
      continue;
    }

    // ---- Clean ------------------------------------------------------------
    options.throttle.noteClean();

    log.info(
      `${prefix}${options.label} — ${response.status} in ${ms}ms` +
        (attempt > 1 ? ` (attempt ${attempt})` : ''),
      { url, ...options.context },
    );

    return {
      html,
      status: response.status,
      attempts: attempt,
      reauthenticated,
      throttled,
      durationMs: Date.now() - startedAt,
    };
  }

  throw new Error(
    `${options.label}: gave up after ${maxAttempts} attempts (${lastProblem}) — ${url}`,
  );
}
