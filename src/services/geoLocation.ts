/**
 * Expected location from an IP address.
 *
 * Backed by `geoip-lite`, which ships a compiled GeoLite2 database and answers
 * from memory. Chosen over a lookup API deliberately: a third party never sees
 * a user's address, there is no key to hold, no rate limit to hit, no per-request
 * latency, and the dashboard keeps working with no outbound network at all.
 *
 * WHAT THIS IS WORTH, HONESTLY
 *
 * It is a guess from an address block, and the dashboard should say "expected"
 * rather than "location":
 *
 *   - a VPN or a mobile carrier's NAT defeats it completely;
 *   - the free dataset knows the COUNTRY far more reliably than the city, and
 *     often returns an empty city for a perfectly valid address;
 *   - the coordinates are the centre of a range, not a person, and for a
 *     country-only match they are the middle of the country.
 *
 * So callers get whatever is actually known and nothing invented: a missing city
 * stays missing rather than being filled in from the country.
 *
 * The bundled data ages. `geoip-lite` ships an updater
 * (`node node_modules/geoip-lite/scripts/updatedb.js`) worth running
 * periodically — an address block reassigned to another country is silently
 * wrong until then.
 */

import geoip from 'geoip-lite';

import { isPrivateAddress } from './clientIp.js';
import { createLogger } from '../log.js';

const log = createLogger('geoip');

export interface ExpectedLocation {
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * ISO country codes to names, for the countries this actually serves plus the
 * common ones. Falls back to the code itself, which is still readable — better
 * an admin sees "SG" than a blank cell.
 *
 * A full ISO table is not worth carrying: `Intl.DisplayNames` does it properly
 * and is built in, so it is used when available and this is only the fallback
 * for a runtime without the locale data.
 */
function countryName(code: string): string {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Look up an address. Returns `undefined` when there is nothing useful to say —
 * a private address, an unknown block, or a malformed input — so a caller never
 * has to tell "we do not know" apart from "somewhere with no name".
 */
export function expectedLocation(ip: string | undefined): ExpectedLocation | undefined {
  if (!ip || isPrivateAddress(ip)) return undefined;

  let record: geoip.Lookup | null;
  try {
    record = geoip.lookup(ip);
  } catch (error) {
    // A bad address must never take down the request it arrived on.
    log.warn('Geo lookup failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  if (!record) return undefined;

  const [latitude, longitude] = record.ll ?? [];

  const location: ExpectedLocation = {
    ...(record.country ? { countryCode: record.country } : {}),
    ...(record.country ? { country: countryName(record.country) } : {}),
    // Empty strings are the dataset's way of saying "not known". Carrying them
    // through would render as a location the dashboard cannot explain.
    ...(record.region ? { region: record.region } : {}),
    ...(record.city ? { city: record.city } : {}),
    ...(record.timezone ? { timezone: record.timezone } : {}),
    ...(typeof latitude === 'number' ? { latitude } : {}),
    ...(typeof longitude === 'number' ? { longitude } : {}),
  };

  return Object.keys(location).length > 0 ? location : undefined;
}

/** One line for a dashboard cell: "Dublin, Ireland" / "Ireland" / undefined. */
export function locationLabel(location: ExpectedLocation | undefined): string | undefined {
  if (!location) return undefined;
  const parts = [location.city, location.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}
