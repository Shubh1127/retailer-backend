/**
 * Authentication for the whole API — retailers and administrators alike.
 *
 * This replaces the admin-only gate. The retailer app used to be unauthenticated
 * on the grounds that it "runs on a trusted network and only reads", which was
 * true of the API and never true of the premise: an anonymous caller has no
 * identity, so there is nobody to show in a users dashboard, nothing to attach a
 * last-login to, and nothing a block could possibly stop.
 *
 * HOW THE TOKEN IS VERIFIED
 *
 * By asking Supabase, not by decoding the JWT here. `GET /auth/v1/user` with the
 * caller's bearer token returns the user when it is valid and 401 when it is
 * not. That costs one HTTP call and buys three things worth more than the
 * latency:
 *
 *   - no JWT signing secret in this process, so there is one fewer secret to
 *     leak and none to rotate here when Supabase rotates theirs;
 *   - signing-algorithm changes on Supabase's side cannot silently break or,
 *     worse, silently weaken verification;
 *   - a revoked or signed-out session stops working immediately, rather than
 *     staying valid until the token's own expiry.
 *
 * WHAT IS CACHED, AND WHAT DELIBERATELY IS NOT
 *
 * The token→identity result is cached briefly, so a dashboard making twenty
 * calls does not make twenty verification round trips.
 *
 * The DIRECTORY lookup — role, and whether the account is blocked — is not
 * cached with it. Blocking someone has to take effect now, not in thirty
 * seconds, or an admin watching a person do something has no way to stop them.
 * That costs one indexed primary-key read per request, which is the right trade.
 *
 * THE SERVICE ROLE KEY NEVER LEAVES THIS PROCESS. The browser holds a user token
 * scoped by RLS; the backend holds the service role key. That asymmetry is the
 * whole reason this API exists rather than the apps talking to Supabase.
 */

import type { IncomingMessage } from 'node:http';

import { readSupabaseConfig } from '../db/supabase.js';
import {
  loadUser,
  recordSeen,
  type AppUser,
  type UserRole,
} from '../repositories/appUser.repository.js';
import { clientIp } from './clientIp.js';
import { createLogger } from '../log.js';

const log = createLogger('auth');

/** Short enough that a sign-out takes effect quickly, long enough to matter. */
const CACHE_TTL_MS = 30_000;

/** The verified Supabase identity, before the directory is consulted. */
export interface AuthIdentity {
  id: string;
  email?: string;
}

/** A fully resolved caller: verified, looked up, and known not to be blocked. */
export interface AuthUser extends AuthIdentity {
  role: UserRole;
  blocked: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface CacheEntry {
  identity: AuthIdentity;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Pull the bearer token out of an Authorization header. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Which email addresses are administrators regardless of the directory.
 *
 * `ADMIN_EMAILS` is kept as the SEED, not as the mechanism. It is how the first
 * administrator exists before anyone can grant a role, and how access is
 * recovered if the directory is wrong. Roles are otherwise held in `app_users`,
 * where they can be changed without a redeploy and carry an audit trail.
 */
function seedAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

let warnedAboutOpenAccess = false;

function isSeedAdmin(email: string | undefined): boolean {
  const allowed = seedAdminEmails();

  if (allowed.length === 0) {
    if (!warnedAboutOpenAccess) {
      warnedAboutOpenAccess = true;
      log.warn(
        'ADMIN_EMAILS is unset — ANY authenticated Supabase user can administer ' +
          'the catalogue. Set it before this is reachable from the internet.',
      );
    }
    return true;
  }

  return Boolean(email && allowed.includes(email.toLowerCase()));
}

/** Verify a bearer token and return the identity it belongs to. */
async function verifyToken(token: string): Promise<AuthIdentity> {
  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;

  let config;
  try {
    config = readSupabaseConfig();
  } catch {
    // Without Supabase nobody can be verified, and the safe answer to "who is
    // this" is nobody.
    throw new AuthError(503, 'Sign-in is unavailable — Supabase is not configured');
  }

  let response: Response;
  try {
    response = await fetch(`${config.url.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Supabase requires the project apikey alongside the user's token. It is
        // only ever sent to Supabase.
        apikey: config.serviceRoleKey,
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    throw new AuthError(
      503,
      `Could not reach Supabase to verify the session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    // Do not echo Supabase's body back — it can carry token fragments.
    throw new AuthError(401, 'Your session is not valid. Sign in again.');
  }

  const body = (await response.json()) as { id?: string; email?: string };
  if (!body.id) {
    throw new AuthError(401, 'Your session is not valid. Sign in again.');
  }

  const identity: AuthIdentity = {
    id: body.id,
    ...(body.email ? { email: body.email } : {}),
  };

  cache.set(token, { identity, expiresAt: Date.now() + CACHE_TTL_MS });
  return identity;
}

/**
 * Authenticate any caller.
 *
 * Verifies the token, records the sighting (which is what populates the users
 * dashboard), and refuses a blocked account. Throws rather than returning null,
 * so a handler cannot fall through unauthenticated by omission.
 */
export async function authenticateUser(req: IncomingMessage): Promise<AuthUser> {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new AuthError(401, 'Sign in to continue');

  const identity = await verifyToken(token);

  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'];

  // Seeded so the very first request from a listed admin creates their row
  // already holding the role, rather than as a retailer needing promotion.
  const defaultRole: UserRole = isSeedAdmin(identity.email) ? 'admin' : 'retailer';

  const directoryUser = await recordSeen({
    id: identity.id,
    ...(identity.email ? { email: identity.email } : {}),
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
    defaultRole,
  });

  // `recordSeen` returns null only when the directory could not be read. Falling
  // back to the seed keeps the API usable during a directory outage, and is safe
  // in the direction that matters: it cannot invent an administrator who is not
  // in ADMIN_EMAILS, and it cannot unblock anybody, because a request that
  // cannot confirm the block is refused below.
  if (!directoryUser) {
    if (!isSeedAdmin(identity.email)) {
      throw new AuthError(503, 'The user directory is unavailable — try again shortly');
    }
    return { ...identity, role: 'admin', blocked: false };
  }

  if (directoryUser.blocked) {
    throw new AuthError(
      403,
      directoryUser.blockedReason
        ? `This account has been blocked: ${directoryUser.blockedReason}`
        : 'This account has been blocked. Contact an administrator.',
    );
  }

  // The directory wins, EXCEPT that a seeded address is always an admin — that
  // is the recovery path if someone demotes the last administrator.
  const role: UserRole =
    directoryUser.role === 'admin' || isSeedAdmin(identity.email) ? 'admin' : 'retailer';

  return { ...identity, role, blocked: false };
}

/** Authenticate, and require the caller to be an administrator. */
export async function authenticateAdmin(req: IncomingMessage): Promise<AuthUser> {
  const user = await authenticateUser(req);

  if (user.role !== 'admin') {
    // 403, not 401: the session is valid, the person simply is not an admin.
    // Sending them to sign in again would loop them through something that
    // cannot succeed.
    throw new AuthError(403, 'This account is not an administrator');
  }

  return user;
}

/** Drop a token from the cache — used on sign-out. */
export function forgetToken(header: string | undefined): void {
  const token = bearerToken(header);
  if (token) cache.delete(token);
}

/** Test seam: clear the verification cache. */
export function resetAuthCache(): void {
  cache.clear();
}

export type { AppUser };
