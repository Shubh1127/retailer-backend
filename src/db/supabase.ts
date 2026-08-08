/**
 * Supabase client factory.
 *
 * Server-side only. The SERVICE ROLE key is required: the musgrave_* tables have
 * RLS enabled with no policies, so an anon key sees nothing. The key never leaves
 * the backend.
 *
 * The client is created lazily and cached, so importing this module costs nothing
 * and a missing configuration only fails when Supabase is actually used.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

/** Read and validate configuration from the environment. */
export function readSupabaseConfig(): SupabaseConfig {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  return { url, serviceRoleKey };
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const config = readSupabaseConfig();

  client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return client;
}

/** Drop the cached client (tests / credential rotation). */
export function resetSupabaseClient(): void {
  client = null;
}
