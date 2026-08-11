/**
 * `/api/signup` — the only unauthenticated write surface in this API.
 *
 *   POST /api/signup/requests            ask for an account (email only)
 *   GET  /api/signup/requests/status     has an admin decided yet?
 *   POST /api/signup/requests/complete   set a password, become a real user
 *
 * WHY NO PASSWORD IS TAKEN AT STEP ONE
 *
 * A password collected before approval has to be kept somewhere until the
 * approval arrives, and there is no good answer to where. Taking it at step
 * three means this system never holds a password for an account that does not
 * exist yet — the request table has no password column, hashed or otherwise.
 *
 * WHY A CLAIM TOKEN AND NOT THE EMAIL
 *
 * If "this address is approved, set a password" were claimable by presenting
 * the address, then knowing an approved email would be the whole account. The
 * browser that made the request is handed a random token once and must present
 * it for both the status poll and the completion; only its hash is stored.
 *
 * WHAT THIS DELIBERATELY DOES NOT TELL A CALLER
 *
 * Whether an address already has an account, already applied, or was rejected.
 * All of them answer the same way, because this endpoint is reachable by
 * anybody and the difference between those answers is a membership oracle.
 * The requester learns their own status only by holding the token.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  completeSignupRequest,
  createSignupRequest,
  findByClaimToken,
  type SignupRequest,
} from '../repositories/signupRequest.repository.js';
import { checkPassword } from './passwordPolicy.js';
import { clientIp } from './clientIp.js';
import { getSupabaseClient } from '../db/supabase.js';
import { createLogger } from '../log.js';

const log = createLogger('signup-routes');

const CORS = {
  'Access-Control-Allow-Origin': process.env.APP_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
  return true;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // An unauthenticated endpoint must not let a caller decide how much memory
    // to allocate. Nothing legitimate here exceeds a couple of hundred bytes.
    if (size > 8 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Not RFC 5322 — deliberately. The point is to reject obvious rubbish before it
 * reaches the admin queue, not to adjudicate exotic-but-legal addresses. An
 * address that passes this and is still wrong is caught by the admin reading
 * it, which is the step this whole flow is built around.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Per-address throttle for the public endpoints.
 *
 * In memory on purpose: this is a speed bump against someone hammering the
 * request endpoint to fill an admin's queue or to probe the status endpoint,
 * and a speed bump does not need to survive a restart or be shared between
 * instances. A serious flood is a job for whatever sits in front of this
 * process; a table write per attempt is what needs stopping here.
 */
const RATE_LIMIT = { windowMs: 60_000, maxPerWindow: 10 };
const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return false;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT.maxPerWindow) return true;

  // Bounded so a stream of distinct addresses cannot grow this without limit.
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (v.resetAt <= now) attempts.delete(k);
    }
  }

  return false;
}

/** Test seam: forget every throttle bucket. */
export function resetSignupRateLimit(): void {
  attempts.clear();
}

/** What the requester is told about their own request. Never another's. */
function publicView(request: SignupRequest) {
  return {
    email: request.email,
    // 'rejected' is reported as-is rather than disguised. The person applied
    // and is entitled to know they were turned down; what they are not told is
    // the reason, which is an internal note.
    status: request.status,
    requestedAt: request.requestedAt,
  };
}

/** The token, from the header or the query string. */
function claimTokenFrom(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers['x-claim-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return (fromHeader ?? url.searchParams.get('token') ?? undefined)?.trim() || undefined;
}

export async function handleSignupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (!path.startsWith('/api/signup')) return false;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const ip = clientIp(req);

  try {
    // ---- Ask for an account -----------------------------------------------
    if (method === 'POST' && path === '/api/signup/requests') {
      if (rateLimited(`request:${ip ?? 'unknown'}`)) {
        return sendJson(res, 429, {
          error: 'Too many attempts. Wait a minute and try again.',
        });
      }

      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim() : '';

      if (!EMAIL.test(email)) {
        return sendJson(res, 400, { error: 'Enter a valid email address.' });
      }

      const result = await createSignupRequest({
        email,
        ...(ip ? { ip } : {}),
        ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
      });

      if ('existing' in result) {
        // No token. A second browser must not be able to take over a request
        // the first one is still holding — that is precisely the takeover the
        // token exists to prevent.
        return sendJson(res, 409, {
          error:
            'A request for that email address is already waiting. Check the ' +
            'browser you started it in, or ask an administrator.',
          status: result.existing.status,
        });
      }

      log.info('Account requested', {
        email: result.request.email,
        ip: result.request.ip ?? 'unknown',
        newIp: !result.request.ipSeenBefore,
      });

      return sendJson(res, 201, {
        ...publicView(result.request),
        // Returned exactly once. There is no endpoint that will show it again.
        claimToken: result.claimToken,
      });
    }

    // ---- Poll the decision -------------------------------------------------
    if (method === 'GET' && path === '/api/signup/requests/status') {
      const token = claimTokenFrom(req, url);
      if (!token) return sendJson(res, 400, { error: 'Missing claim token.' });

      if (rateLimited(`status:${ip ?? 'unknown'}`)) {
        return sendJson(res, 429, { error: 'Too many attempts.' });
      }

      // Looked up BY the hash of the presented token, so a row coming back is
      // itself the proof — there is no second comparison to make, and no
      // timing oracle, because a wrong token matches no row at all.
      const request = await findByClaimToken(token);
      // 404 for a token that matches nothing, whatever the reason. A caller
      // holding a bad token learns only that it is bad.
      if (!request) {
        return sendJson(res, 404, { error: 'That request could not be found.' });
      }

      return sendJson(res, 200, publicView(request));
    }

    // ---- Set the password, become a user -----------------------------------
    if (method === 'POST' && path === '/api/signup/requests/complete') {
      if (rateLimited(`complete:${ip ?? 'unknown'}`)) {
        return sendJson(res, 429, { error: 'Too many attempts.' });
      }

      const body = await readJson(req);
      const token = typeof body.claimToken === 'string' ? body.claimToken.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!token) return sendJson(res, 400, { error: 'Missing claim token.' });

      const request = await findByClaimToken(token);
      if (!request) {
        return sendJson(res, 404, { error: 'That request could not be found.' });
      }

      if (request.status !== 'approved') {
        return sendJson(res, 409, {
          error:
            request.status === 'pending'
              ? 'This request has not been approved yet.'
              : 'This request is no longer open.',
          status: request.status,
        });
      }

      if (Date.parse(request.tokenExpiresAt) <= Date.now()) {
        return sendJson(res, 410, {
          error: 'This approval has expired. Ask an administrator to re-issue it.',
        });
      }

      // Checked BEFORE the auth user is created. A rejected password after a
      // successful createUser would leave an account nobody can sign in to and
      // a request that can never be completed.
      const check = checkPassword(password);
      if (!check.ok) {
        return sendJson(res, 400, {
          error: 'That password does not meet the requirements.',
          failed: check.failed,
          messages: check.messages,
        });
      }

      const supabase = getSupabaseClient();

      const { data, error } = await supabase.auth.admin.createUser({
        email: request.email,
        password,
        // The admin approving the request IS the verification. Sending a
        // confirmation email on top would block the account behind a mailbox
        // this system has no way to send to.
        email_confirm: true,
      });

      if (error || !data.user) {
        log.error('Could not create the account', {
          email: request.email,
          message: error?.message ?? 'no user returned',
        });
        // A duplicate address is the one failure a caller can act on.
        const duplicate = /already|exists|registered/i.test(error?.message ?? '');
        return sendJson(res, duplicate ? 409 : 502, {
          error: duplicate
            ? 'An account already exists for that email address. Try signing in.'
            : 'The account could not be created. Try again shortly.',
        });
      }

      const completed = await completeSignupRequest(request.id, data.user.id);
      if (!completed) {
        // The guard did its job: something else completed this request between
        // the check above and here. The account exists and belongs to whoever
        // won, so this caller must not be told it is theirs.
        log.warn('Request was completed concurrently', { id: request.id });
        return sendJson(res, 409, { error: 'This request is no longer open.' });
      }

      log.info('Account created from an approved request', {
        email: request.email,
        userId: data.user.id,
      });

      // No session is returned. The browser signs in with the password it just
      // chose, which keeps this endpoint out of the business of issuing
      // credentials and means the session comes from Supabase exactly as it
      // does for every other sign-in.
      return sendJson(res, 201, { email: request.email });
    }

    return sendJson(res, 404, { error: `No route for ${method} ${path}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/not configured/i.test(message)) {
      return sendJson(res, 503, {
        error: 'Account requests are unavailable right now.',
      });
    }
    if (/too large/i.test(message)) {
      return sendJson(res, 413, { error: 'Request body is too large.' });
    }
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { error: 'Invalid JSON body.' });
    }

    log.error('Signup route failed', { path, message });
    return sendJson(res, 500, { error: 'Something went wrong. Try again shortly.' });
  }
}
