/**
 * Will a concurrent crawl get us challenged by Cloudflare?
 *
 * The catalogue sync is ~5,700 requests. Choosing its concurrency by intuition
 * risks a trade account, so this asks the site directly with short bursts at
 * increasing concurrency, watching for the things that mean "slow down":
 *
 *   - 403 / 429 / 503, the usual rate-limit and challenge statuses
 *   - a `cf-mitigated` header, which is Cloudflare saying it acted
 *   - challenge markup in the body, which arrives with a 200 and would
 *     otherwise be parsed as a product page containing no products
 *   - the login form, meaning the session was dropped
 *   - latency climbing sharply, which is throttling before blocking
 *
 * ABORTS on the first sign, rather than pushing to find the ceiling. The goal
 * is a safe setting, not the maximum one.
 *
 * Read-only.
 */

import 'dotenv/config';
import * as cheerio from 'cheerio';

import { BASE_URL, ensureSession } from '../services/oreilly.service.js';
import { mapWithConcurrency, sleep } from '../services/supplierSearch.js';

/** Bursts are deliberately small — enough to see a pattern, not to provoke one. */
const BURST = 24;
const LEVELS = [1, 3, 5];

const session = await ensureSession();

// Real product URLs to fetch, taken from one listing page.
const listing = await session.client.get(
  `${BASE_URL}/products/gridlist.asp?DeptCode=4&chkpm=MALL`,
);
const $ = cheerio.load(listing.data as string);

const urls = $('.ProductBox')
  .map((_, el) => cheerio.load(el)('a[href*="DetailsPortal"]').first().attr('href'))
  .get()
  .filter((href): href is string => Boolean(href))
  .map((href) => BASE_URL + href);

console.log(`${urls.length} product URLs available for probing\n`);

interface Outcome {
  status: number;
  ms: number;
  mitigated?: string;
  challenged: boolean;
  loginPage: boolean;
}

async function fetchOne(url: string): Promise<Outcome> {
  const at = Date.now();
  const response = await session.client.get(url, { validateStatus: () => true });
  const ms = Date.now() - at;
  const body = String(response.data ?? '');

  return {
    status: response.status,
    ms,
    ...(response.headers['cf-mitigated']
      ? { mitigated: String(response.headers['cf-mitigated']) }
      : {}),
    challenged:
      /just a moment|attention required|challenge-platform|cf-error|_cf_chl/i.test(
        body.slice(0, 4000),
      ),
    loginPage: /name=["']password["']/i.test(body),
  };
}

let safest = 0;

for (const lanes of LEVELS) {
  const batch = urls.slice(0, BURST);
  const at = Date.now();

  const results = await mapWithConcurrency(batch, lanes, (url) => fetchOne(url));

  const elapsed = (Date.now() - at) / 1000;
  const rate = batch.length / elapsed;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  const bad = results.filter(
    (r) => r.status !== 200 || r.challenged || r.loginPage || r.mitigated,
  );

  console.log(
    `concurrency ${lanes}: ${batch.length} requests in ${elapsed.toFixed(1)}s ` +
      `(${rate.toFixed(1)} req/s), median ${median}ms, ` +
      `slowest ${times[times.length - 1]}ms`,
  );

  if (bad.length > 0) {
    const first = bad[0]!;
    console.log(
      `  BLOCKED/THROTTLED — ${bad.length}/${batch.length} bad. ` +
        `status=${first.status} challenged=${first.challenged} ` +
        `login=${first.loginPage} mitigated=${first.mitigated ?? 'no'}`,
    );
    console.log(`\nStop here. Highest clean concurrency: ${safest || 'none'}`);
    process.exit(0);
  }

  console.log('  all 200, no challenge, no mitigation');
  safest = lanes;

  // Let anything token-bucket-shaped refill before the next level.
  await sleep(3000);
}

console.log(`\nAll levels clean. Highest tested safely: ${safest} concurrent.`);
console.log(
  'Note: a clean burst is evidence, not a guarantee — Cloudflare reacts to ' +
    'sustained volume, and the real sync is ~5,700 requests over many minutes.',
);
