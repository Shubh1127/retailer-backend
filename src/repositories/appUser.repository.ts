/**
 * The user directory — who exists, what they may do, and where they signed in.
 *
 * Every authenticated request passes through `recordSeen`. That is what keeps
 * the dashboard honest without a signup hook: a user appears here the first time
 * they are seen, and their last-seen, address and location are current by
 * construction rather than by a job that might not have run.
 *
 * WHY WRITES ARE BEST-EFFORT AND READS ARE NOT
 *
 * `recordSeen` never throws. It is bookkeeping on the side of a request the user
 * actually made, and losing one heartbeat is worth far less than failing an
 * upload because a tracking table was briefly unavailable.
 *
 * `loadUser` — which decides role and blocking — is the opposite: its failure is
 * reported, and the caller treats "cannot tell" as "not an administrator". A
 * directory outage must not silently promote anyone or silently unblock anyone.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { expectedLocation, type ExpectedLocation } from '../services/geoLocation.js';
import { createLogger } from '../log.js';

const log = createLogger('app-users');

export type UserRole = 'retailer' | 'admin';

/**
 * The location a user granted, as opposed to the one guessed from their IP.
 *
 * Kept apart from `ExpectedLocation` in the type system as well as the schema:
 * one is evidence of consent and the other is explicitly not, and code that can
 * mix them up eventually will.
 */
export interface PreciseLocation {
  latitude: number;
  longitude: number;
  accuracyMetres?: number;
  /** Place name, when the reverse lookup found one. */
  label?: string;
  updatedAt?: string;
  consentAt?: string;
}

export interface AppUser {
  id: string;
  email?: string;
  role: UserRole;
  blocked: boolean;
  blockedReason?: string;
  blockedByEmail?: string;
  blockedAt?: string;
  firstSeenAt?: string;
  lastLoginAt?: string;
  lastSeenAt?: string;
  lastIp?: string;
  lastUserAgent?: string;
  location?: ExpectedLocation;
  /** Present only when the user granted browser location permission. */
  precise?: PreciseLocation;
}

export interface UserSession {
  id: number;
  userId: string;
  startedAt: string;
  lastSeenAt: string;
  ip?: string;
  userAgent?: string;
  location?: ExpectedLocation;
}

/**
 * How long a gap makes the next request a NEW session rather than the same one.
 *
 * Thirty minutes is the usual analytics convention and it is a good fit here:
 * short enough that "signed in this morning, again after lunch" reads as two
 * sessions, long enough that a person reading one long job does not accumulate
 * a row every time they click.
 */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * How recently someone must have been seen to count as online.
 *
 * Derived, never stored. A stored `is_online` flag is correct only until the
 * process that set it exits without clearing it, and then it is permanently
 * wrong for that user — which is exactly the failure an admin would trust.
 */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export function isOnline(lastSeenAt: string | undefined): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && Date.now() - seen < ONLINE_WINDOW_MS;
}

function toAppUser(record: Record<string, any>): AppUser {
  const location: ExpectedLocation = {
    ...(record.last_country ? { country: record.last_country } : {}),
    ...(record.last_country_code ? { countryCode: record.last_country_code } : {}),
    ...(record.last_region ? { region: record.last_region } : {}),
    ...(record.last_city ? { city: record.last_city } : {}),
    ...(record.last_timezone ? { timezone: record.last_timezone } : {}),
    ...(record.last_latitude != null ? { latitude: Number(record.last_latitude) } : {}),
    ...(record.last_longitude != null ? { longitude: Number(record.last_longitude) } : {}),
  };

  return {
    id: String(record.id),
    ...(record.email ? { email: String(record.email) } : {}),
    role: record.role === 'admin' ? 'admin' : 'retailer',
    blocked: Boolean(record.blocked),
    ...(record.blocked_reason ? { blockedReason: String(record.blocked_reason) } : {}),
    ...(record.blocked_by_email ? { blockedByEmail: String(record.blocked_by_email) } : {}),
    ...(record.blocked_at ? { blockedAt: String(record.blocked_at) } : {}),
    ...(record.first_seen_at ? { firstSeenAt: String(record.first_seen_at) } : {}),
    ...(record.last_login_at ? { lastLoginAt: String(record.last_login_at) } : {}),
    ...(record.last_seen_at ? { lastSeenAt: String(record.last_seen_at) } : {}),
    ...(record.last_ip ? { lastIp: String(record.last_ip) } : {}),
    ...(record.last_user_agent ? { lastUserAgent: String(record.last_user_agent) } : {}),
    ...(Object.keys(location).length > 0 ? { location } : {}),
    // Only when coordinates actually exist. A row with a consent timestamp but
    // no position is somebody who said yes and whose browser then failed, and
    // reporting that as a location would be inventing one.
    ...(record.precise_latitude != null && record.precise_longitude != null
      ? {
          precise: {
            latitude: Number(record.precise_latitude),
            longitude: Number(record.precise_longitude),
            ...(record.precise_accuracy_m != null
              ? { accuracyMetres: Number(record.precise_accuracy_m) }
              : {}),
            ...(record.precise_label ? { label: String(record.precise_label) } : {}),
            ...(record.precise_updated_at
              ? { updatedAt: String(record.precise_updated_at) }
              : {}),
            ...(record.location_consent_at
              ? { consentAt: String(record.location_consent_at) }
              : {}),
          },
        }
      : {}),
  };
}

/** One user by id. Throws on a database failure — see the module note. */
export async function loadUser(id: string): Promise<AppUser | null> {
  const { data, error } = await getSupabaseClient()
    .from('app_users')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`Could not read the user directory: ${error.message}`);
  return data ? toAppUser(data as Record<string, any>) : null;
}

/** Everyone, newest activity first. The users dashboard's only read. */
export async function listUsers(limit = 500): Promise<AppUser[]> {
  const { data, error } = await getSupabaseClient()
    .from('app_users')
    .select('*')
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not list users: ${error.message}`);
  return (data ?? []).map((record) => toAppUser(record as Record<string, any>));
}

/** A user's recent sessions — the "where has this account been used" answer. */
export async function listSessions(userId: string, limit = 20): Promise<UserSession[]> {
  const { data, error } = await getSupabaseClient()
    .from('user_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not read sessions: ${error.message}`);

  return (data ?? []).map((raw: Record<string, any>) => {
    const location: ExpectedLocation = {
      ...(raw.country ? { country: raw.country } : {}),
      ...(raw.country_code ? { countryCode: raw.country_code } : {}),
      ...(raw.region ? { region: raw.region } : {}),
      ...(raw.city ? { city: raw.city } : {}),
      ...(raw.timezone ? { timezone: raw.timezone } : {}),
      ...(raw.latitude != null ? { latitude: Number(raw.latitude) } : {}),
      ...(raw.longitude != null ? { longitude: Number(raw.longitude) } : {}),
    };

    return {
      id: Number(raw.id),
      userId,
      startedAt: String(raw.started_at),
      lastSeenAt: String(raw.last_seen_at),
      ...(raw.ip ? { ip: String(raw.ip) } : {}),
      ...(raw.user_agent ? { userAgent: String(raw.user_agent) } : {}),
      ...(Object.keys(location).length > 0 ? { location } : {}),
    };
  });
}

export interface SeenContext {
  id: string;
  email?: string;
  ip?: string;
  userAgent?: string;
  /** Seed role for a user being created for the first time. */
  defaultRole?: UserRole;
}

/**
 * Record that a user was just seen, and return their current directory row.
 *
 * Creates the row if this is the first sighting. Never overwrites `role` or
 * `blocked` on an existing row — those are administrative decisions, and a
 * heartbeat that could reset them would undo a block every time the blocked
 * person retried.
 */
export async function recordSeen(context: SeenContext): Promise<AppUser | null> {
  const db = getSupabaseClient();
  const now = new Date().toISOString();
  const location = expectedLocation(context.ip);

  let existing: AppUser | null = null;
  try {
    existing = await loadUser(context.id);
  } catch (error) {
    log.warn('Could not read the user before recording a sighting', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  // A new session when the address or the browser changes, or after a long
  // enough gap — which is as close to "a new sign-in" as a stateless API can
  // get without the client telling us, and does not trust it to.
  const previousSeen = existing?.lastSeenAt ? Date.parse(existing.lastSeenAt) : 0;
  const idleTooLong = !previousSeen || Date.now() - previousSeen > SESSION_IDLE_MS;
  const movedNetwork = Boolean(existing) && existing?.lastIp !== context.ip;
  const changedClient = Boolean(existing) && existing?.lastUserAgent !== context.userAgent;
  const startsSession = !existing || idleTooLong || movedNetwork || changedClient;

  const row: Record<string, unknown> = {
    id: context.id,
    email: context.email ?? existing?.email ?? null,
    last_seen_at: now,
    last_ip: context.ip ?? null,
    last_user_agent: context.userAgent ?? null,
    last_country: location?.country ?? null,
    last_country_code: location?.countryCode ?? null,
    last_region: location?.region ?? null,
    last_city: location?.city ?? null,
    last_timezone: location?.timezone ?? null,
    last_latitude: location?.latitude ?? null,
    last_longitude: location?.longitude ?? null,
    ...(startsSession ? { last_login_at: now } : {}),
    // Only ever set on insert. Spreading these unconditionally would let a
    // request reset a block.
    ...(existing ? {} : { role: context.defaultRole ?? 'retailer', blocked: false }),
  };

  const { data, error } = await db
    .from('app_users')
    .upsert(row, { onConflict: 'id' })
    .select()
    .maybeSingle();

  if (error) {
    log.warn('Could not record the sighting', { message: error.message });
    return existing;
  }

  if (startsSession) {
    const { error: sessionError } = await db.from('user_sessions').insert({
      user_id: context.id,
      started_at: now,
      last_seen_at: now,
      ip: context.ip ?? null,
      user_agent: context.userAgent ?? null,
      country: location?.country ?? null,
      country_code: location?.countryCode ?? null,
      region: location?.region ?? null,
      city: location?.city ?? null,
      timezone: location?.timezone ?? null,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
    });
    if (sessionError) {
      log.warn('Could not record the session', { message: sessionError.message });
    }
  } else {
    // Extend the newest session rather than adding one.
    const { data: latest } = await db
      .from('user_sessions')
      .select('id')
      .eq('user_id', context.id)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest?.id) {
      await db.from('user_sessions').update({ last_seen_at: now }).eq('id', latest.id);
    }
  }

  return data ? toAppUser(data as Record<string, any>) : existing;
}

export interface BlockRequest {
  userId: string;
  blocked: boolean;
  reason?: string;
  byEmail?: string;
}

/** Block or unblock. Returns the updated row so the caller can render it. */
export async function setBlocked(request: BlockRequest): Promise<AppUser> {
  const { data, error } = await getSupabaseClient()
    .from('app_users')
    .update({
      blocked: request.blocked,
      // Cleared on unblock, so a stale reason never sits beside an active
      // account looking like it still applies.
      blocked_reason: request.blocked ? (request.reason ?? null) : null,
      blocked_by_email: request.blocked ? (request.byEmail ?? null) : null,
      blocked_at: request.blocked ? new Date().toISOString() : null,
    })
    .eq('id', request.userId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Could not update the block: ${error.message}`);
  if (!data) throw new Error('No such user');

  log.info(request.blocked ? 'User blocked' : 'User unblocked', {
    userId: request.userId,
    by: request.byEmail,
  });

  return toAppUser(data as Record<string, any>);
}

export interface PreciseLocationInput {
  userId: string;
  latitude: number;
  longitude: number;
  accuracyMetres?: number;
  label?: string;
}

/**
 * Store the location a user consented to share.
 *
 * `location_consent_at` is only ever set, never cleared here: it records that
 * permission was granted at a point in time, which stays true even if the
 * position is replaced later. Revoking is a separate, deliberate act — see
 * `forgetPreciseLocation`.
 */
export async function savePreciseLocation(
  input: PreciseLocationInput,
): Promise<AppUser> {
  const now = new Date().toISOString();

  const { data, error } = await getSupabaseClient()
    .from('app_users')
    .update({
      precise_latitude: input.latitude,
      precise_longitude: input.longitude,
      precise_accuracy_m: input.accuracyMetres ?? null,
      precise_label: input.label ?? null,
      precise_updated_at: now,
      location_consent_at: now,
    })
    .eq('id', input.userId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Could not save the location: ${error.message}`);
  if (!data) throw new Error('No such user');

  return toAppUser(data as Record<string, any>);
}

/**
 * Forget a user's shared location.
 *
 * Clears the consent timestamp too. Somebody who withdraws their location has
 * withdrawn the permission, and leaving the timestamp behind would let the app
 * treat them as still having agreed.
 */
export async function forgetPreciseLocation(userId: string): Promise<AppUser> {
  const { data, error } = await getSupabaseClient()
    .from('app_users')
    .update({
      precise_latitude: null,
      precise_longitude: null,
      precise_accuracy_m: null,
      precise_label: null,
      precise_updated_at: null,
      location_consent_at: null,
    })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Could not clear the location: ${error.message}`);
  if (!data) throw new Error('No such user');

  return toAppUser(data as Record<string, any>);
}

/** Change a user's role. */
export async function setRole(userId: string, role: UserRole): Promise<AppUser> {
  const { data, error } = await getSupabaseClient()
    .from('app_users')
    .update({ role })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Could not update the role: ${error.message}`);
  if (!data) throw new Error('No such user');
  return toAppUser(data as Record<string, any>);
}
