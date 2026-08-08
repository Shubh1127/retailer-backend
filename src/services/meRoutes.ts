/**
 * `/api/me` — who the caller is, according to the backend.
 *
 *   GET    /api/me            identity, role, store, and best-known location
 *   PUT    /api/me/location   store the location the browser was allowed to share
 *   DELETE /api/me/location   forget it again
 *
 * Both apps call GET on load, and it answers a question the browser cannot
 * answer for itself. Supabase issuing a token proves the person signed in; it
 * says nothing about whether this system considers them a retailer, an
 * administrator, or blocked. Only the backend knows that, because only the
 * backend can read the user directory.
 *
 * So it doubles as the session probe: 200 means "you are in, here is your role",
 * 401 means "sign in", and 403 means "signed in, and stopped" — the distinction
 * a gate needs to avoid looping a blocked user through a login that cannot help.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { AuthError, authenticateUser } from './auth.js';
import { locationLabel } from './geoLocation.js';
import { reverseGeocode } from './reverseGeocode.js';
import {
  forgetPreciseLocation,
  loadUser,
  savePreciseLocation,
  type AppUser,
} from '../repositories/appUser.repository.js';
import { listJobs, savingsSince } from '../repositories/processingJob.repository.js';
import { SUPPLIER_IDS } from './supplierSearch.js';
import { createLogger } from '../log.js';

const log = createLogger('me-routes');

const CORS = {
  'Access-Control-Allow-Origin': process.env.APP_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
  return true;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The location to show, and where it came from.
 *
 * Precise wins when present, because the user gave it deliberately and it is
 * right. The IP guess is the fallback, and it is labelled as a guess — a
 * dashboard that shows an approximation with the same confidence as a granted
 * location is quietly lying about which one it has.
 */
function locationFor(user: AppUser | null): {
  label?: string;
  source: 'precise' | 'ip' | 'unknown';
  accuracyMetres?: number;
  canAsk: boolean;
} {
  if (user?.precise?.label) {
    return {
      label: user.precise.label,
      source: 'precise',
      ...(user.precise.accuracyMetres !== undefined
        ? { accuracyMetres: user.precise.accuracyMetres }
        : {}),
      canAsk: false,
    };
  }

  // Coordinates but no name — the reverse lookup failed or is switched off. The
  // position is still known and still consented to, so it is not "unknown"; the
  // IP's country is the most honest label available for it.
  if (user?.precise) {
    return {
      ...(locationLabel(user.location) ? { label: locationLabel(user.location)! } : {}),
      source: 'precise',
      ...(user.precise.accuracyMetres !== undefined
        ? { accuracyMetres: user.precise.accuracyMetres }
        : {}),
      canAsk: false,
    };
  }

  const fromIp = locationLabel(user?.location);
  return {
    ...(fromIp ? { label: fromIp } : {}),
    source: fromIp ? 'ip' : 'unknown',
    // Nobody has granted permission yet, so the dashboard may offer to ask.
    canAsk: true,
  };
}

export async function handleMeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (
    path !== '/api/me' &&
    path !== '/api/me/location' &&
    path !== '/api/me/stats'
  ) {
    return false;
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  let user;
  try {
    user = await authenticateUser(req);
  } catch (error) {
    if (error instanceof AuthError) {
      return sendJson(res, error.status, { error: error.message });
    }
    log.error('Identity check failed unexpectedly', {
      message: error instanceof Error ? error.message : String(error),
    });
    return sendJson(res, 500, { error: 'Could not check your session' });
  }

  try {
    // ---- The location the browser was allowed to share --------------------
    if (path === '/api/me/location' && method === 'PUT') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' });
      }

      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);

      // Validated rather than trusted. These arrive from a browser, and a
      // latitude of 900 would be stored happily and then plotted somewhere
      // impossible.
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        return sendJson(res, 400, {
          error: 'latitude and longitude must be a real position',
        });
      }

      const accuracy = Number(body.accuracyMetres);

      // The name is a convenience. If the lookup fails or is disabled the
      // position is still stored — losing the label must not lose the location.
      const label = await reverseGeocode(latitude, longitude);

      const updated = await savePreciseLocation({
        userId: user.id,
        latitude,
        longitude,
        ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracyMetres: accuracy } : {}),
        ...(label ? { label } : {}),
      });

      return sendJson(res, 200, { location: locationFor(updated) });
    }

    if (path === '/api/me/location' && method === 'DELETE') {
      const updated = await forgetPreciseLocation(user.id);
      return sendJson(res, 200, { location: locationFor(updated) });
    }

    // ---- What this retailer actually saved --------------------------------
    //
    // Powers the landing page's headline figures for a signed-in retailer.
    // They were hardcoded — "€30.00 saved this week" to everybody, including
    // people whose real figure was nothing — which on a page a signed-in user
    // lands on is a statement about THEIR account, and it was false.
    if (path === '/api/me/stats' && method === 'GET') {
      const days = 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const window = await savingsSince(since, user.id);

      return sendJson(res, 200, {
        days,
        since,
        jobs: window.jobs,
        lines: window.lines,
        savings: window.savings,
        baselineSpend: window.baseline,
        // Share of the spend that was actually compared. Null rather than 0
        // when there is no baseline: "0%" claims we compared and found nothing,
        // which is a different fact from having nothing to compare against.
        savingsPct:
          window.baseline > 0
            ? Number(((window.savings / window.baseline) * 100).toFixed(1))
            : null,
        // The live roster, not a number typed into the page. It was "6" while
        // two suppliers were actually integrated.
        suppliers: SUPPLIER_IDS.length,
      });
    }

    if (path !== '/api/me' || method !== 'GET') {
      return sendJson(res, 405, { error: `No route for ${method} ${path}` });
    }

    // ---- Who am I ---------------------------------------------------------
    const directory = await loadUser(user.id);

    // The store name comes from the retailer's own uploads — the EPOS export
    // states it — so the shell can show where they actually trade rather than a
    // placeholder. Absent until they have uploaded something, which is honest:
    // we genuinely do not know before then.
    let storeName: string | undefined;
    try {
      const [latest] = await listJobs(1, user.id);
      if (latest?.storeName) storeName = latest.storeName;
    } catch {
      // A history lookup failing must not fail the session probe every app
      // calls on load.
    }

    return sendJson(res, 200, {
      user: {
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
        role: user.role,
        ...(storeName ? { storeName } : {}),
        ...(directory?.lastLoginAt ? { lastLoginAt: directory.lastLoginAt } : {}),
      },
      location: locationFor(directory),
    });
  } catch (error) {
    log.error('Request failed', {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
}
