/**
 * Client for the Query Understanding service (FastAPI + fine-tuned DistilBERT).
 *
 * Answers one question: given an order line, which supplier search queries
 * should be issued for it? That is the ONLY stage this replaces. SBERT still
 * ranks the candidates that come back, the rule engine still judges them and
 * reconciliation still gates them — none of those are touched, and this module
 * deliberately exposes nothing that would let them be.
 *
 * FAILURE IS A DEGRADATION, NOT AN OUTAGE
 *
 * `understandQuery` never rejects. A service that is down, slow or missing its
 * model returns an `error` and no queries, and the caller falls back to the
 * rule-based ladder in `parsing/searchQuery.ts` — which is exactly what the
 * pipeline used before this existed. A model outage must cost recall, never a
 * retailer's order.
 */

import { createLogger } from '../log.js';

const log = createLogger('query-understanding');

/** Shares the AI service with SBERT. Override with AI_SERVICE_URL. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';

/**
 * Short on purpose. This call sits in front of supplier search on every line of
 * a 2000-row file, so a slow answer is worse than no answer: the fallback
 * ladder is already good, and waiting 20s per line to maybe improve it is not a
 * trade worth making.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Where the Query Understanding half lives.
 *
 * `QUERY_UNDERSTANDING_URL` first, `AI_SERVICE_URL` second.
 *
 * The two models can run in one process or two — together they exceed a 500 MB
 * tier, and they share no state, so which it is stays a deployment choice. A
 * combined instance sets only `AI_SERVICE_URL` and nothing changes; a split one
 * points this at its own service. Deliberately a DIFFERENT variable from the
 * match client's, so pointing one half somewhere new cannot silently move the
 * other.
 */
export function aiServiceBaseUrl(): string {
  const url =
    process.env.QUERY_UNDERSTANDING_URL?.trim() ||
    process.env.AI_SERVICE_URL?.trim() ||
    DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

/** Is model-driven query generation switched on? */
export function queryUnderstandingEnabled(): boolean {
  const raw = (process.env.QUERY_UNDERSTANDING ?? 'off').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

export interface UnderstoodAttributes {
  brand?: string | null;
  product?: string | null;
  variant?: string | null;
  form?: string | null;
  container?: string | null;
  pack?: string | null;
  multipack?: string | null;
  size?: string | null;
  caseQty?: number | null;
  removed?: string[];
}

export interface UnderstoodQuery {
  /** Supplier search queries, most specific first. */
  searchQueries: string[];
  attributes: UnderstoodAttributes;
  confidence: number;
  durationMs: number;
  /** Set when the service could not be reached or answered an error. */
  error?: string;
}

interface UnderstandResponse {
  searchQueries?: string[];
  attributes?: UnderstoodAttributes;
  confidence?: number;
}

export interface UnderstandOptions {
  timeoutMs?: number;
  baseUrl?: string;
  maxQueries?: number;
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Ask the model what one order line is asking for.
 *
 * The RAW description is sent, not the normalized one. The model was trained on
 * retail language — prices, "46P", "BTL", compound words and all — so
 * normalizing first would hand it text it never saw in training and strip the
 * very tokens it was taught to recognise and drop.
 */
export async function understandQuery(
  description: string,
  opts: UnderstandOptions = {},
): Promise<UnderstoodQuery> {
  const startedAt = Date.now();
  const text = description?.trim() ?? '';

  if (!text) {
    return { searchQueries: [], attributes: {}, confidence: 0, durationMs: 0 };
  }

  const url = `${opts.baseUrl ?? aiServiceBaseUrl()}/understand`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: text,
        ...(opts.maxQueries !== undefined ? { maxQueries: opts.maxQueries } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
    }

    const json = (await response.json()) as UnderstandResponse;

    return {
      // Uppercased and de-duplicated here so the caller can issue them in order
      // without checking. Suppliers search case-insensitively, but the retailer
      // recognises their own products in the case their EPOS export uses.
      searchQueries: [
        ...new Set(
          (json.searchQueries ?? [])
            .map((query) => query.trim().replace(/\s+/g, ' ').toUpperCase())
            .filter(Boolean),
        ),
      ],
      attributes: json.attributes ?? {},
      confidence: json.confidence ?? 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      searchQueries: [],
      attributes: {},
      confidence: 0,
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

export interface QueryUnderstandingHealth {
  reachable: boolean;
  modelLoaded: boolean;
  error?: string;
}

/**
 * One-shot readiness probe, for use before a long job.
 *
 * Reports the QUERY model specifically. The service answering `/health` says
 * nothing about whether the query model loaded — SBERT can be resident while
 * this one is absent, and that combination degrades silently otherwise.
 */
export async function checkQueryUnderstanding(
  baseUrl = aiServiceBaseUrl(),
): Promise<QueryUnderstandingHealth> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as { queryUnderstandingLoaded?: boolean };
    return {
      reachable: response.ok,
      modelLoaded: body.queryUnderstandingLoaded === true,
    };
  } catch (error) {
    log.warn('Query Understanding health probe failed', { error: errorMessage(error) });
    return { reachable: false, modelLoaded: false, error: errorMessage(error) };
  }
}
