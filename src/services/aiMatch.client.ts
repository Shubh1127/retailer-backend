/**
 * Client for the AI matching service (FastAPI + SBERT).
 *
 * The AI service is external and knows nothing about Excel files, suppliers or
 * allocation: it takes one product plus its candidates and returns a semantic
 * similarity per candidate. This module owns the wire contract — the URL, the
 * request shape, the timeout, and the `score` → `similarity` rename — so the
 * batch dashboard and the dev harness cannot drift apart.
 *
 * Failure is a normal outcome, not an exception. A product whose AI call fails
 * still has to reach the dashboard, so `rankCandidates` never rejects: it
 * returns an empty ranking with an `error`, and the caller decides what that
 * means for the line.
 */

import { createLogger } from '../log.js';

const log = createLogger('ai-match');

/** Default location of the AI service. Override with AI_SERVICE_URL. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Where the SBERT half lives.
 *
 * `AI_MATCH_URL` first, `AI_SERVICE_URL` second.
 *
 * The two models can be deployed as one process or as two — together they
 * exceed a 500 MB tier, and they share no state, so splitting them is a
 * deployment choice rather than an architectural one. The fallback is what
 * keeps that choice invisible here: a single combined instance needs only
 * `AI_SERVICE_URL`, exactly as before, and a split deployment sets the two
 * specific variables instead. Nothing in the calling code knows which it is.
 */
export function aiServiceBaseUrl(): string {
  const url =
    process.env.AI_MATCH_URL?.trim() ||
    process.env.AI_SERVICE_URL?.trim() ||
    DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

/** One supplier product as the AI service expects it. */
export interface AiCandidate {
  supplier: string;
  name: string;
  brand?: string;
  unitsPerCase?: number;
  unitSize?: number;
  ean?: string;
  sku?: string;
}

export interface AiQuery {
  description: string;
  unitsPerCase?: number;
  unitSize?: number;
}

/** A scored candidate, indexed back into the request's candidate array. */
export interface AiRanking {
  candidateIndex: number;
  similarity: number;
}

export interface AiRankResult {
  ranking: AiRanking[];
  durationMs: number;
  /** Set when the service could not be reached or answered an error. */
  error?: string;
}

interface AiMatchResponse {
  rowId: number | string;
  ranking: { candidateIndex: number; score: number }[];
}

export interface RankOptions {
  timeoutMs?: number;
  baseUrl?: string;
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Rank one product's candidates by semantic similarity.
 *
 * `rowId` is echoed by the service and is only used for correlation in its logs;
 * the ranking is matched back by `candidateIndex`.
 */
export async function rankCandidates(
  rowId: number | string,
  query: AiQuery,
  candidates: readonly AiCandidate[],
  opts: RankOptions = {},
): Promise<AiRankResult> {
  // Nothing to rank is not a failure, and calling out for an empty answer is
  // wasted latency on every unmatched line in a 2000-row file.
  if (candidates.length === 0) return { ranking: [], durationMs: 0 };

  const url = `${opts.baseUrl ?? aiServiceBaseUrl()}/match`;
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowId, query, candidates }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as AiMatchResponse;

    return {
      // The service's `score` becomes `similarity` here, so the AI service keeps
      // its own vocabulary and the backend keeps its own.
      ranking: (json.ranking ?? []).map((entry) => ({
        candidateIndex: entry.candidateIndex,
        similarity: entry.score,
      })),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ranking: [],
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

export interface AiHealth {
  reachable: boolean;
  status?: string;
  model?: string;
  error?: string;
}

/** One-shot readiness probe, used before starting a long job. */
export async function checkAiService(baseUrl = aiServiceBaseUrl()): Promise<AiHealth> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as { status?: string; model?: string };
    return {
      reachable: response.ok,
      ...(body.status ? { status: body.status } : {}),
      ...(body.model ? { model: body.model } : {}),
    };
  } catch (error) {
    log.warn('AI service health probe failed', { error: errorMessage(error) });
    return { reachable: false, error: errorMessage(error) };
  }
}
