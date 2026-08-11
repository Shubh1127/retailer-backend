/**
 * Account requests — created by a stranger, decided by an admin.
 *
 * WHY READS HERE THROW RATHER THAN RETURNING NULL
 *
 * Every function in this file is on the path of a decision that must not fail
 * open. "Could not read the request" and "there is no such request" are the
 * same answer to a caller that treats a null as absence, and one of them means
 * a database blip could let an unapproved claim through. So absence is `null`
 * and failure throws, and the routes turn a throw into a 503.
 *
 * WHY THE TOKEN IS HASHED HERE AND NOWHERE ELSE
 *
 * `hashClaimToken` is the only place that knows the encoding. Callers hand over
 * the raw token and never see the hash, so there is no route by which a hash
 * could be compared against a hash of a hash, and no second implementation to
 * drift.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { getSupabaseClient } from '../db/supabase.js';
import { expectedLocation, type ExpectedLocation } from '../services/geoLocation.js';
import { createLogger } from '../log.js';

const log = createLogger('signup-requests');

export type SignupStatus = 'pending' | 'approved' | 'rejected' | 'completed';

/**
 * How long an approval stays claimable.
 *
 * An approved request is an account waiting to be created, so it should not sit
 * there for ever. Seven days is long enough to survive a weekend and a
 * forgotten tab, short enough that an abandoned approval expires rather than
 * accumulating.
 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SignupRequest {
  id: string;
  email: string;
  status: SignupStatus;
  requestedAt: string;
  reviewedAt?: string;
  reviewedByEmail?: string;
  reviewNote?: string;
  completedAt?: string;
  tokenExpiresAt: string;
  ip?: string;
  userAgent?: string;
  location?: ExpectedLocation;
  /** False → the address is new to the system; the admin is asked to confirm. */
  ipSeenBefore: boolean;
}

/** Lowercased and trimmed. The form everything compares on. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A URL-safe token with 256 bits of entropy.
 *
 * Base64url rather than hex so it stays short enough to sit in localStorage and
 * a request body without wrapping, and `randomBytes` rather than anything
 * seeded from the clock — this token is the only thing standing between a known
 * email address and a working account.
 */
export function createClaimToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare two hashes without leaking where they first differ.
 *
 * The lookup is by hash, so an attacker cannot iterate against it — but the
 * comparison is free to be constant-time and there is no reason to hand out the
 * timing signal.
 */
export function claimTokenMatches(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashClaimToken(token), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

function toSignupRequest(record: Record<string, any>): SignupRequest {
  const location: ExpectedLocation = {
    ...(record.country ? { country: record.country } : {}),
    ...(record.country_code ? { countryCode: record.country_code } : {}),
    ...(record.region ? { region: record.region } : {}),
    ...(record.city ? { city: record.city } : {}),
    ...(record.timezone ? { timezone: record.timezone } : {}),
    ...(record.latitude != null ? { latitude: Number(record.latitude) } : {}),
    ...(record.longitude != null ? { longitude: Number(record.longitude) } : {}),
  };

  return {
    id: String(record.id),
    email: String(record.email ?? ''),
    status: (record.status ?? 'pending') as SignupStatus,
    requestedAt: String(record.requested_at ?? record.created_at ?? ''),
    ...(record.reviewed_at ? { reviewedAt: String(record.reviewed_at) } : {}),
    ...(record.reviewed_by_email ? { reviewedByEmail: String(record.reviewed_by_email) } : {}),
    ...(record.review_note ? { reviewNote: String(record.review_note) } : {}),
    ...(record.completed_at ? { completedAt: String(record.completed_at) } : {}),
    tokenExpiresAt: String(record.token_expires_at ?? ''),
    ...(record.ip ? { ip: String(record.ip) } : {}),
    ...(record.user_agent ? { userAgent: String(record.user_agent) } : {}),
    ...(Object.keys(location).length > 0 ? { location } : {}),
    ipSeenBefore: Boolean(record.ip_seen_before),
  };
}

/**
 * Has this address been seen anywhere before?
 *
 * Checked against three histories — where users last were, every session ever
 * recorded, and every earlier request. A second person signing up from the
 * shop's own broadband is unremarkable and should not be flagged; a first
 * request from an address nothing in the system has ever seen is exactly what
 * an admin should look at twice.
 *
 * A private address (local development, or a deployment with no TRUST_PROXY)
 * counts as NOT seen: it says nothing about who is calling, and silently
 * treating "we cannot tell" as "familiar" would clear the warning for every
 * request in exactly the setup where the warning matters least but is most
 * likely to be believed.
 */
export async function isIpKnown(ip: string | undefined): Promise<boolean> {
  if (!ip) return false;

  const supabase = getSupabaseClient();

  const probes = [
    supabase.from('app_users').select('id').eq('last_ip', ip).limit(1),
    supabase.from('user_sessions').select('id').eq('ip', ip).limit(1),
    supabase.from('signup_requests').select('id').eq('ip', ip).limit(1),
  ];

  const results = await Promise.all(probes);

  for (const { data, error } of results) {
    // A failed probe is not evidence of absence. Reported and treated as "not
    // known", which leaves the warning on — the cautious direction.
    if (error) {
      log.warn('IP history probe failed', { message: error.message });
      continue;
    }
    if (data && data.length > 0) return true;
  }

  return false;
}

export interface CreateSignupRequestInput {
  email: string;
  ip?: string;
  userAgent?: string;
}

export interface CreatedSignupRequest {
  request: SignupRequest;
  /** Returned ONCE, to the requesting browser. Never stored, never re-readable. */
  claimToken: string;
}

/**
 * Record a new request, or return the existing live one for that address.
 *
 * A repeat submission of the same address is not an error — people double-click
 * and revisit — but it must not mint a second token, or the first browser's
 * token would silently stop working. Existing live requests are returned with
 * no token, and the route turns that into "you already have a request pending",
 * which is the honest answer and leaks nothing: it is the same response an
 * address that never applied would get if it had.
 */
export async function createSignupRequest(
  input: CreateSignupRequestInput,
): Promise<CreatedSignupRequest | { existing: SignupRequest }> {
  const supabase = getSupabaseClient();
  const emailNormalized = normalizeEmail(input.email);

  const { data: live, error: liveError } = await supabase
    .from('signup_requests')
    .select('*')
    .eq('email_normalized', emailNormalized)
    .in('status', ['pending', 'approved'])
    .limit(1);

  if (liveError) {
    throw new Error(`Could not check for an existing request: ${liveError.message}`);
  }
  if (live && live.length > 0) {
    return { existing: toSignupRequest(live[0] as Record<string, any>) };
  }

  const claimToken = createClaimToken();
  const location = expectedLocation(input.ip);
  const ipSeenBefore = await isIpKnown(input.ip);

  const { data, error } = await supabase
    .from('signup_requests')
    .insert({
      email: input.email.trim(),
      email_normalized: emailNormalized,
      status: 'pending',
      claim_token_hash: hashClaimToken(claimToken),
      token_expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userAgent ? { user_agent: input.userAgent } : {}),
      ...(location?.country ? { country: location.country } : {}),
      ...(location?.countryCode ? { country_code: location.countryCode } : {}),
      ...(location?.region ? { region: location.region } : {}),
      ...(location?.city ? { city: location.city } : {}),
      ...(location?.timezone ? { timezone: location.timezone } : {}),
      ...(location?.latitude != null ? { latitude: location.latitude } : {}),
      ...(location?.longitude != null ? { longitude: location.longitude } : {}),
      ip_seen_before: ipSeenBefore,
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Could not record the request: ${error.message}`);
  }

  return { request: toSignupRequest(data as Record<string, any>), claimToken };
}

/** The request a claim token belongs to, or null when no row matches. */
export async function findByClaimToken(token: string): Promise<SignupRequest | null> {
  if (!token) return null;

  const { data, error } = await getSupabaseClient()
    .from('signup_requests')
    .select('*')
    .eq('claim_token_hash', hashClaimToken(token))
    .limit(1);

  if (error) {
    throw new Error(`Could not look up the request: ${error.message}`);
  }
  if (!data || data.length === 0) return null;

  return toSignupRequest(data[0] as Record<string, any>);
}

/** The admin queue. Newest last for pending, so it reads as a queue. */
export async function listSignupRequests(
  status?: SignupStatus,
  limit = 200,
): Promise<SignupRequest[]> {
  let query = getSupabaseClient()
    .from('signup_requests')
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    throw new Error(`Could not list account requests: ${error.message}`);
  }

  return (data ?? []).map((row) => toSignupRequest(row as Record<string, any>));
}

/**
 * Approve or reject.
 *
 * Guarded on the CURRENT status in the same statement that changes it, so two
 * admins clicking at once cannot both succeed — the second update matches no
 * row and the caller is told the request was already decided, rather than the
 * later click silently overwriting the earlier one.
 */
export async function reviewSignupRequest(
  id: string,
  decision: 'approved' | 'rejected',
  reviewer: { email?: string; note?: string },
): Promise<SignupRequest | null> {
  const { data, error } = await getSupabaseClient()
    .from('signup_requests')
    .update({
      status: decision,
      reviewed_at: new Date().toISOString(),
      ...(reviewer.email ? { reviewed_by_email: reviewer.email } : {}),
      ...(reviewer.note ? { review_note: reviewer.note } : {}),
      // Approval restarts the clock: the window should run from the decision,
      // not from a request that may have waited days for it.
      ...(decision === 'approved'
        ? { token_expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString() }
        : {}),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*');

  if (error) {
    throw new Error(`Could not record the decision: ${error.message}`);
  }
  if (!data || data.length === 0) return null;

  return toSignupRequest(data[0] as Record<string, any>);
}

/**
 * Mark an approved request as used.
 *
 * Guarded on `status = 'approved'` for the same reason as above, and this one
 * matters more: it is what makes the claim token single-use. Two simultaneous
 * completions would otherwise both try to create the same auth user.
 */
export async function completeSignupRequest(
  id: string,
  createdUserId: string,
): Promise<SignupRequest | null> {
  const { data, error } = await getSupabaseClient()
    .from('signup_requests')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      created_user_id: createdUserId,
    })
    .eq('id', id)
    .eq('status', 'approved')
    .select('*');

  if (error) {
    throw new Error(`Could not complete the request: ${error.message}`);
  }
  if (!data || data.length === 0) return null;

  return toSignupRequest(data[0] as Record<string, any>);
}

/**
 * Which of these addresses already have an account.
 *
 * ADMIN-SIDE ONLY. This answer must never reach a public endpoint: "that
 * address is registered" is an email-enumeration oracle, and the whole reason
 * `POST /api/signup/requests` answers identically for a known address, an
 * unknown one and one that already applied is to avoid handing it out. An
 * administrator asking the same question is already trusted with the user list.
 *
 * WHY TWO SOURCES
 *
 * `app_users` is written on the first authenticated REQUEST, not at creation —
 * so an account made moments ago that has not been used yet is not there. The
 * completed requests cover that: anyone who finished this flow has a row
 * whatever they have done since.
 *
 * The remaining gap is an account created straight in the Supabase dashboard
 * that has never signed in. That one is caught later, by `createUser` refusing
 * a duplicate, so approving it fails safely rather than silently.
 *
 * Batched deliberately: the queue is read whole, and one query per row would be
 * four hundred round trips for a two hundred row list.
 */
export async function accountsExistFor(emails: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (wanted.length === 0) return new Set();

  const supabase = getSupabaseClient();
  const found = new Set<string>();

  const [users, completed] = await Promise.all([
    // `app_users.email` is stored as Supabase reported it, so it is compared
    // case-insensitively rather than against the normalized form.
    supabase.from('app_users').select('email').not('email', 'is', null),
    supabase
      .from('signup_requests')
      .select('email_normalized')
      .eq('status', 'completed')
      .in('email_normalized', wanted),
  ]);

  if (users.error) {
    // Reported, not thrown. This annotates a queue an admin is reading; losing
    // it costs a badge, and failing the whole list would cost them the queue.
    log.warn('Could not check existing accounts', { message: users.error.message });
  } else {
    const wantedSet = new Set(wanted);
    for (const row of users.data ?? []) {
      const email = normalizeEmail(String((row as Record<string, any>).email ?? ''));
      if (email && wantedSet.has(email)) found.add(email);
    }
  }

  if (completed.error) {
    log.warn('Could not check completed requests', { message: completed.error.message });
  } else {
    for (const row of completed.data ?? []) {
      const email = String((row as Record<string, any>).email_normalized ?? '');
      if (email) found.add(email);
    }
  }

  return found;
}

/** How many requests are waiting — the badge on the admin nav. */
export async function countPendingSignupRequests(): Promise<number> {
  const { count, error } = await getSupabaseClient()
    .from('signup_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  if (error) {
    throw new Error(`Could not count account requests: ${error.message}`);
  }

  return count ?? 0;
}
