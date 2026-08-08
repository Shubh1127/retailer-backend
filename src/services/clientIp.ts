/**
 * Which address a request actually came from.
 *
 * WHY THIS IS NOT ONE LINE
 *
 * `X-Forwarded-For` is a header, and a header is whatever the client typed. Any
 * caller can send `X-Forwarded-For: 1.2.3.4` and, if we believe it, appear in
 * the users dashboard as somebody in another country — and, once blocking is
 * enforced by address, evade a block by changing a string.
 *
 * It is only trustworthy when something we control sets it: a load balancer or
 * reverse proxy that overwrites the header on the way in. Whether that is true
 * is a deployment fact this process cannot detect, so it is declared with
 * `TRUST_PROXY` rather than guessed.
 *
 *   TRUST_PROXY unset  the socket address wins. Correct when the backend is
 *                      reached directly. Behind a proxy every user appears to
 *                      share the proxy's address — wrong, but visibly and
 *                      harmlessly wrong, and fixed by setting the variable.
 *
 *   TRUST_PROXY set    the left-most X-Forwarded-For entry wins, which is the
 *                      original client as recorded by the first proxy.
 *
 * The unsafe direction is the one that defaults off. A dashboard showing the
 * proxy's IP is a nuisance; a dashboard showing whatever a user claims is a lie
 * that looks like data.
 *
 * DEV_CLIENT_IP
 *
 * In local development every request arrives from loopback, which has no
 * geography, so the users dashboard can only ever say "Unknown" and the geo
 * path cannot be exercised at all. `DEV_CLIENT_IP=203.0.113.5` stands in a
 * public address so it can be.
 *
 * It is deliberately NOT gated on `NODE_ENV`: nothing in this backend sets that
 * variable, so `NODE_ENV !== 'production'` would be true in production too and
 * the guard would be theatre. Two real properties keep it honest instead —
 *
 *   - it is an environment variable, so only whoever runs the process can set
 *     it. Unlike X-Forwarded-For it is not reachable by a client, so it is a
 *     misconfiguration risk, never an attack surface;
 *   - it only substitutes when the real address is private. Left set by
 *     accident on a deployed server, genuine users keep their own addresses and
 *     only the unmappable ones change, so it cannot quietly rewrite real data.
 *
 * It still logs loudly, because a dashboard showing an invented location should
 * never be a silent condition.
 */

import type { IncomingMessage } from 'node:http';

import { createLogger } from '../log.js';

const log = createLogger('client-ip');

export function trustsProxy(): boolean {
  const value = (process.env.TRUST_PROXY ?? '').trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'no';
}

let warnedAboutUntrustedForwarding = false;

/**
 * IPv6-mapped IPv4 addresses ("::ffff:203.0.113.5") are the same address written
 * differently, and Node hands them over in that form on a dual-stack socket. Two
 * spellings of one address would show as two sessions.
 */
function normalize(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const trimmed = address.trim();
  if (!trimmed) return undefined;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped) return mapped[1]!;

  // Loopback, written either way. Worth collapsing so local development does
  // not produce two "different" sessions for the same machine.
  if (trimmed === '::1') return '127.0.0.1';

  return trimmed;
}

export function clientIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  if (trustsProxy()) {
    // "client, proxy1, proxy2" — the left-most entry is the original caller.
    const first = header?.split(',')[0];
    const fromHeader = normalize(first);
    if (fromHeader) return substituteForDevelopment(fromHeader);
  } else if (header && !warnedAboutUntrustedForwarding) {
    warnedAboutUntrustedForwarding = true;
    log.warn(
      'X-Forwarded-For is present but TRUST_PROXY is not set, so it is being ' +
        'ignored and every user will appear to share the proxy address. Set ' +
        'TRUST_PROXY=1 only if a proxy you control overwrites that header.',
    );
  }

  return substituteForDevelopment(normalize(req.socket.remoteAddress ?? undefined));
}

let warnedAboutDevAddress = false;

/**
 * Swap a private address for `DEV_CLIENT_IP` so local development has something
 * geolocatable. Returns the address untouched when the variable is unset, when
 * the address is already public, or when the override is itself unusable.
 */
function substituteForDevelopment(ip: string | undefined): string | undefined {
  const override = normalize(process.env.DEV_CLIENT_IP);
  if (!override) return ip;

  // A public address is real data and outranks a stand-in.
  if (!isPrivateAddress(ip)) return ip;

  if (isPrivateAddress(override)) {
    if (!warnedAboutDevAddress) {
      warnedAboutDevAddress = true;
      log.warn(
        'DEV_CLIENT_IP is a private address and cannot be geolocated, so it is ' +
          'being ignored. Use a public address.',
        { override },
      );
    }
    return ip;
  }

  if (!warnedAboutDevAddress) {
    warnedAboutDevAddress = true;
    log.warn(
      'DEV_CLIENT_IP is set, so private addresses are being reported as this ' +
        'address instead. Locations in the users dashboard are not real. Unset ' +
        'it outside local development.',
      { override },
    );
  }

  return override;
}

/** True for addresses that can never be geolocated — loopback, LAN, link-local. */
export function isPrivateAddress(ip: string | undefined): boolean {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  // Unique local addresses, the IPv6 equivalent of 10.x.
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}
