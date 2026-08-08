/**
 * Supabase connectivity checks.
 *
 * Uses the singleton client from `./supabase.js` — nothing here opens its own
 * connection. The startup check is memoized on its promise, so it runs and prints
 * exactly once no matter how many times it is called or from how many places.
 */

import { getSupabaseClient } from './supabase.js';
import { createLogger } from '../log.js';

const log = createLogger('supabase');

/** Tables the Musgrave category migration is expected to create. */
export const MUSGRAVE_TABLES = [
  'musgrave_categories',
  'musgrave_category_attributes',
  'musgrave_category_paths',
  'musgrave_sync_runs',
] as const;

/** The table the startup check probes — cheapest useful signal. */
export const PROBE_TABLE = 'musgrave_categories';

/** PostgREST's "relation is not in the schema cache" code. */
const TABLE_MISSING_CODE = 'PGRST205';

export interface SupabaseError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface SupabaseCheckResult {
  ok: boolean;
  table: string;
  /** Row count when reachable (head-only query, no rows transferred). */
  count?: number;
  error?: SupabaseError;
  /** True when the failure is specifically "this table does not exist". */
  tableMissing?: boolean;
}

function toSupabaseError(error: unknown): SupabaseError {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    return {
      message: typeof e.message === 'string' ? e.message : String(error),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.details === 'string' ? { details: e.details } : {}),
      ...(typeof e.hint === 'string' ? { hint: e.hint } : {}),
    };
  }
  return { message: String(error) };
}

/**
 * Lightweight reachability probe: an exact count with at most one row returned.
 *
 * Deliberately NOT a `head: true` query. PostgREST answers a HEAD request for a
 * table that does not exist with `204 No Content` and no body, which surfaces
 * through supabase-js as `error: null, count: null` — indistinguishable from an
 * empty table. A real single-row request returns the 404/PGRST205 properly, and
 * costs one row.
 */
export async function checkSupabaseConnection(
  table: string = PROBE_TABLE,
): Promise<SupabaseCheckResult> {
  try {
    const supabase = getSupabaseClient();

    const { count, data, error, status } = await supabase
      .from(table)
      .select('id', { count: 'exact' })
      .limit(1);

    if (error) {
      const parsed = toSupabaseError(error);
      return {
        ok: false,
        table,
        error: parsed,
        tableMissing: parsed.code === TABLE_MISSING_CODE,
      };
    }

    // Belt and braces: never report success on a non-2xx, whatever the body said.
    if (typeof status === 'number' && status >= 400) {
      return {
        ok: false,
        table,
        error: { message: `Unexpected HTTP ${status} querying "${table}"` },
        tableMissing: status === 404,
      };
    }

    return { ok: true, table, count: count ?? data?.length ?? 0 };
  } catch (error) {
    // Missing configuration, DNS/TLS failures, and anything else non-PostgREST.
    return { ok: false, table, error: toSupabaseError(error) };
  }
}

/** Probe every table the migration should have created. */
export async function verifySupabaseTables(): Promise<SupabaseCheckResult[]> {
  const results: SupabaseCheckResult[] = [];
  for (const table of MUSGRAVE_TABLES) {
    results.push(await checkSupabaseConnection(table));
  }
  return results;
}

/** Render a database error in full — never truncated, never swallowed. */
export function formatSupabaseError(error: SupabaseError): string {
  const lines = [`message : ${error.message}`];
  if (error.code) lines.push(`code    : ${error.code}`);
  if (error.details) lines.push(`details : ${error.details}`);
  if (error.hint) lines.push(`hint    : ${error.hint}`);
  return lines.join('\n');
}

let startupCheck: Promise<SupabaseCheckResult> | null = null;

async function runStartupCheck(): Promise<SupabaseCheckResult> {
  console.log('----------------------------------');
  console.log('');
  console.log('Connecting to Supabase...');
  console.log('');

  const result = await checkSupabaseConnection();

  if (result.ok) {
    console.log('✅ Connected to Supabase');
    console.log(`   ${result.table}: ${result.count} row(s)`);
  } else {
    console.error('❌ Could not connect to Supabase');
    console.error('');
    console.error(formatSupabaseError(result.error ?? { message: 'Unknown error' }));
    if (result.tableMissing) {
      console.error('');
      console.error(
        `The connection works but "${result.table}" does not exist — apply` +
          ' supabase/migrations/20260730120000_musgrave_categories.sql, then reload' +
          " the project's schema cache.",
      );
    }
  }

  console.log('');
  console.log('----------------------------------');

  return result;
}

/**
 * Run the startup connection check, printing the banner exactly once per process.
 * Repeat calls return the first result without printing again.
 *
 * Deliberately does NOT exit on failure: the rest of the API (import, compare,
 * allocation) works without Supabase, so a database outage is reported loudly
 * rather than taking the whole server down.
 */
export function ensureSupabaseStartupCheck(): Promise<SupabaseCheckResult> {
  if (!startupCheck) {
    startupCheck = runStartupCheck().catch((error) => {
      // runStartupCheck already handles its own errors; this is a last resort.
      log.error('Startup check threw unexpectedly', { message: String(error) });
      return { ok: false, table: PROBE_TABLE, error: toSupabaseError(error) };
    });
  }
  return startupCheck;
}

/** Clear the memoized startup check (tests). */
export function resetSupabaseStartupCheck(): void {
  startupCheck = null;
}
