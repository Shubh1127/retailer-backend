/**
 * Discovery worksheet generator.
 *
 * Reads an EPOS Article Order Listing and emits a standalone HTML page with, for
 * each article, a clickable "search on <supplier>" link (by description, since
 * the EPOS file has no EAN). Log in to the supplier sites first, then click a few
 * links to VALIDATE that search finds the right product before we build further.
 *
 * Usage: tsx src/scripts/worksheet.ts <epos-file.xls> [limit] > worksheet.html
 */

import { readFileSync } from 'node:fs';
import { importEposListing } from '../ingest/eposListing.js';
import { musgraveConnector } from '../connectors/musgrave.js';
import { barryGroupConnector } from '../connectors/barrygroup.js';
import { cleanSearchQuery } from '../connectors/types.js';

const file = process.argv[2];
const limit = Number(process.argv[3] ?? 40);
if (!file) {
  console.error('usage: tsx src/scripts/worksheet.ts <epos-file.xls> [limit]');
  process.exit(1);
}

const { storeName, articles } = importEposListing(readFileSync(file));
const rows = articles.slice(0, limit);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const body = rows
  .map((a, i) => {
    const q = cleanSearchQuery(a.description);
    const mus = musgraveConnector.searchUrlByText(q);
    const barry = barryGroupConnector.searchUrlByText(q);
    return `<tr>
      <td class="n">${i + 1}</td>
      <td class="code">${esc(a.articleCode)}</td>
      <td class="desc">${esc(a.description)}<span class="pack">${esc(a.packRaw)}${a.mainCost != null ? ' · cost €' + a.mainCost.toFixed(2) : ''}</span></td>
      <td><a class="btn mus" href="${esc(mus)}" target="_blank" rel="noopener">Search Musgrave ↗</a></td>
      <td><a class="btn bar" href="${esc(barry)}" target="_blank" rel="noopener">Search Barry ↗</a></td>
      <td><label class="ok"><input type="checkbox"> found</label></td>
    </tr>`;
  })
  .join('\n');

process.stdout.write(`<title>Discovery worksheet — ${esc(storeName ?? '')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;margin:0;background:#f4f6f2;color:#17231e}
 header{padding:18px 22px;background:#0e7c68;color:#fff}
 header h1{margin:0;font-size:19px} header p{margin:6px 0 0;opacity:.9;font-size:13px;max-width:60ch;line-height:1.5}
 .wrap{padding:16px}
 table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #e6ebe6;font-size:13.5px;vertical-align:top}
 th{background:#eef1ec;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#56645c}
 td.n{color:#8a978f;font-variant-numeric:tabular-nums} td.code{color:#8a978f;font-size:12px;white-space:nowrap}
 td.desc{font-weight:600;max-width:340px} .pack{display:block;font-weight:400;color:#8a978f;font-size:12px;margin-top:2px}
 .btn{display:inline-block;padding:6px 11px;border-radius:8px;font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap}
 .btn.mus{background:#e3f1ec;color:#0a5b4d} .btn.bar{background:#f6e7ea;color:#8a2b3d}
 .ok{font-size:12.5px;color:#56645c;white-space:nowrap}
 .note{background:#fff8e6;border:1px solid #f0e2b8;color:#6b5518;padding:10px 14px;border-radius:10px;margin:12px 0;font-size:13px;line-height:1.5}
</style>
<header>
 <h1>Discovery worksheet · ${esc(storeName ?? 'Store')}</h1>
 <p>Log in to Musgrave Marketplace and Barry Group in this browser first. Then click a few "Search" links below — each opens that supplier's search for the product's description. Tick "found" when the right product shows with a price. This validates that search works from your order file before we wire it into the app.</p>
</header>
<div class="wrap">
 <div class="note"><b>Musgrave</b> links go straight to its search URL (works like typing + Enter). <b>Barry</b> search is a form on its site — if the link lands on an empty list, type the same description into Barry's own Product Search box; that's the path the app will automate for Barry.</div>
 <table>
  <thead><tr><th>#</th><th>Article</th><th>Description (from your file)</th><th>Musgrave</th><th>Barry Group</th><th>Result</th></tr></thead>
  <tbody>
${body}
  </tbody>
 </table>
</div>
`);
