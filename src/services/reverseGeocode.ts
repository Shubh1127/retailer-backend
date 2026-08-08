/**
 * Coordinates to a place name.
 *
 * THIS ONE CALLS OUT, AND THAT IS A DELIBERATE EXCEPTION
 *
 * `geoLocation.ts` resolves IP addresses against a local database precisely so
 * that no third party is told who is using this system. That reasoning does not
 * carry over unchanged here, but it does not vanish either:
 *
 *   - an IP lookup happens to EVERY user on EVERY request, without asking;
 *   - this happens once, only after the person granted permission, and only for
 *     the account that granted it.
 *
 * There is no offline coordinates-to-name database in this project, so a name
 * means an outbound request. It is worth being clear about what that costs:
 * OpenStreetMap's Nominatim is told a set of coordinates. Nothing is sent that
 * identifies the person — no id, no email, no address — but the coordinates
 * themselves are precise, and that is the trade.
 *
 * Set `REVERSE_GEOCODE=off` to disable it entirely. Coordinates are still
 * stored and the dashboard falls back to the country the IP database already
 * knows, so turning it off degrades the label and loses nothing else.
 *
 * Nominatim's usage policy requires an identifying User-Agent and at most one
 * request per second. Both are honoured below; a shared public endpoint that
 * bans this project's address helps nobody.
 */

import { createLogger } from '../log.js';

const log = createLogger('reverse-geocode');

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';

export function reverseGeocodeEnabled(): boolean {
  const value = (process.env.REVERSE_GEOCODE ?? '').trim().toLowerCase();
  return value !== 'off' && value !== '0' && value !== 'false';
}

/**
 * Identifies this application, as Nominatim's policy requires. An anonymous
 * caller is the one they block first.
 */
function userAgent(): string {
  return (
    process.env.REVERSE_GEOCODE_USER_AGENT ??
    'RetailCompare/0.1 (wholesale price comparison; contact via app administrator)'
  );
}

/**
 * One request per second, process-wide.
 *
 * A queue rather than a rejection: a handful of users granting permission at
 * once should be served a moment apart, not refused. Requests are rare enough
 * that the wait is never long.
 */
let nextSlot = 0;

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const readyAt = Math.max(now, nextSlot);
  nextSlot = readyAt + 1000;
  if (readyAt > now) {
    await new Promise((resolve) => setTimeout(resolve, readyAt - now));
  }
}

/**
 * Coordinates rounded to ~100m for the cache key.
 *
 * Two sightings of one shop are the same place, and re-asking for each is both
 * slower and ruder than answering from memory.
 */
function cacheKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { label: string | undefined; expiresAt: number }>();

/**
 * A short, readable place: "Rathmines, Dublin, Ireland".
 *
 * Built from named parts rather than Nominatim's `display_name`, which is a full
 * postal address — house number and postcode included. Storing a user's exact
 * doorstep to label a dashboard would be collecting far more than the feature
 * needs.
 */
function shortLabel(address: Record<string, unknown> | undefined): string | undefined {
  if (!address) return undefined;

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = address[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };

  const locality = pick('suburb', 'neighbourhood', 'village', 'town', 'city_district');
  const city = pick('city', 'town', 'municipality', 'county');
  const country = pick('country');

  // Deduplicated: "Dublin, Dublin, Ireland" reads as a bug.
  const parts = [locality, city, country].filter(
    (part, index, all): part is string => Boolean(part) && all.indexOf(part) === index,
  );

  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Resolve coordinates to a place name.
 *
 * Never throws and never blocks for long: a failed or slow lookup returns
 * `undefined`, and the caller stores the coordinates regardless. A label is a
 * convenience; losing it must not lose the location.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<string | undefined> {
  if (!reverseGeocodeEnabled()) return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;

  const key = cacheKey(latitude, longitude);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.label;

  try {
    await waitForSlot();

    const url = new URL(ENDPOINT);
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));
    url.searchParams.set('format', 'jsonv2');
    // Neighbourhood level. Enough to say where somebody is, not enough to say
    // which building.
    url.searchParams.set('zoom', '14');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) {
      log.warn('Reverse geocode rejected', { status: response.status });
      return undefined;
    }

    const body = (await response.json()) as { address?: Record<string, unknown> };
    const label = shortLabel(body.address);

    // Cached even when undefined, so a coordinate with no name does not retry
    // on every page load.
    cache.set(key, { label, expiresAt: Date.now() + CACHE_TTL_MS });
    return label;
  } catch (error) {
    log.warn('Reverse geocode failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
