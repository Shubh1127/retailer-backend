/**
 * Interactive compare sheet generator.
 *
 * Picks N branded articles from an EPOS listing and emits a standalone HTML page
 * where, for each product, you get a "search on <supplier>" link AND a price box
 * per supplier. Type what the site shows; the page highlights the cheapest,
 * computes per-line saving vs your Main cost, and totals it — a real comparison
 * built from your own logged-in prices, no automation, no risk.
 *
 * Usage: tsx src/scripts/compareSheet.ts <epos-file.xls> [count] > sheet.html
 */

import { readFileSync } from 'node:fs';
import { importEposListing } from '../ingest/eposListing.js';
import { musgraveConnector } from '../connectors/musgrave.js';
import { barryGroupConnector } from '../connectors/barrygroup.js';
import { cleanSearchQuery } from '../connectors/types.js';

const file = process.argv[2];
const count = Number(process.argv[3] ?? 10);
if (!file) { console.error('usage: tsx src/scripts/compareSheet.ts <epos-file.xls> [count]'); process.exit(1); }

const { storeName, articles } = importEposListing(readFileSync(file));

// Prefer clearly-branded, single-pack items — they search cleanly.
const BRANDY = /SMARTIES|NUTELLA|KINDER|MALTESERS|SNICKERS|MENTOS|WRIGLEY|CADBURY|TAYTO|COCA|PEPSI|RED BULL|BALLYGOWAN|VOLVIC|LUCOZADE|BARRY|NESCAFE|HEINZ|KELLOGG|PRINGLES/i;
const picks = articles.filter((a) => BRANDY.test(a.description) && a.mainCost).slice(0, count);
const rows = picks.length >= count ? picks : [...picks, ...articles.filter((a) => a.mainCost && !picks.includes(a)).slice(0, count - picks.length)];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const data = rows.map((a) => ({
  code: a.articleCode, desc: a.description, pack: a.packRaw,
  main: a.mainCost ?? 0,
  mus: musgraveConnector.searchUrlByText(cleanSearchQuery(a.description)),
  bar: barryGroupConnector.searchUrlByText(cleanSearchQuery(a.description)),
}));

process.stdout.write(`<title>Compare sheet — ${esc(storeName ?? '')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 :root{--brand:#0e7c68;--ink:#17231e;--soft:#56645c;--faint:#8a978f;--line:#e0e5df;--green:#1c855a;--greenbg:#dff0e6;--paper:#f4f6f2}
 body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;margin:0;background:var(--paper);color:var(--ink)}
 header{padding:16px 20px;background:var(--brand);color:#fff}
 header h1{margin:0;font-size:18px} header p{margin:6px 0 0;font-size:13px;opacity:.92;max-width:70ch;line-height:1.5}
 .tot{display:flex;gap:22px;padding:12px 20px;background:#fff;border-bottom:1px solid var(--line);align-items:baseline;position:sticky;top:0;z-index:5}
 .tot .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:700}
 .tot .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--brand)}
 .wrap{padding:14px}
 table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07)}
 th,td{padding:9px 11px;border-bottom:1px solid #eef1ec;font-size:13px;text-align:right;white-space:nowrap}
 th{background:#eef1ec;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--soft)}
 th.l,td.l{text-align:left}
 td.desc{font-weight:600;max-width:230px;white-space:normal} .pack{display:block;color:var(--faint);font-weight:400;font-size:11.5px}
 input.price{width:78px;border:1px solid #cfd6cd;border-radius:7px;padding:5px 7px;text-align:right;font-variant-numeric:tabular-nums;font-family:inherit}
 a.s{display:inline-block;margin-top:4px;font-size:11px;color:var(--brand);text-decoration:none;font-weight:600}
 td.win input{background:var(--greenbg);border-color:var(--green);color:var(--green);font-weight:700}
 td.save{color:var(--green);font-weight:700;font-variant-numeric:tabular-nums}
 .main{color:var(--soft);font-variant-numeric:tabular-nums}
</style>
<header>
 <h1>Compare sheet · ${esc(storeName ?? 'Store')}</h1>
 <p>Log in to Musgrave &amp; Barry in this browser. For each product, click "search", read the price for the matching pack, and type it in. The cheapest cell turns green and the saving vs your Main cost adds up live — a real comparison from your own prices.</p>
</header>
<div class="tot">
 <div><div class="k">Total saving</div><div class="v" id="totSave">€0.00</div></div>
 <div><div class="k">of</div><div class="v" id="totBase" style="color:var(--ink)">€0.00</div></div>
 <div><div class="k">filled</div><div class="v" id="filled" style="color:var(--ink)">0/${rows.length}</div></div>
</div>
<div class="wrap">
 <table><thead><tr>
   <th class="l">Product</th><th class="l">Pack</th><th>Main €</th>
   <th>Musgrave €</th><th>Barry €</th><th>Cheapest</th><th>Save/case</th>
 </tr></thead><tbody id="tb"></tbody></table>
</div>
<script>
const DATA = ${JSON.stringify(data)};
const eur = n => '€'+n.toFixed(2);
const tb = document.getElementById('tb');
DATA.forEach((d,i)=>{
  const tr=document.createElement('tr');
  tr.innerHTML =
   '<td class="l desc">'+d.desc.replace(/[<>&]/g,'')+'<span class="pack">'+d.code+'</span></td>'+
   '<td class="l pack">'+d.pack+'</td>'+
   '<td class="main">'+eur(d.main)+'</td>'+
   '<td data-s="mus"><input class="price" inputmode="decimal" data-i="'+i+'" data-s="mus"><a class="s" href="'+d.mus+'" target="_blank" rel="noopener">search ↗</a></td>'+
   '<td data-s="bar"><input class="price" inputmode="decimal" data-i="'+i+'" data-s="bar"><a class="s" href="'+d.bar+'" target="_blank" rel="noopener">search ↗</a></td>'+
   '<td class="win-name" data-i="'+i+'">—</td>'+
   '<td class="save" data-i="'+i+'"></td>';
  tb.appendChild(tr);
});
function recompute(){
  let save=0, base=0, filled=0;
  DATA.forEach((d,i)=>{
    const cells=[...document.querySelectorAll('input.price[data-i="'+i+'"]')];
    cells.forEach(c=>c.parentElement.classList.remove('win'));
    const vals=cells.map(c=>({s:c.dataset.s, v:parseFloat(c.value)})).filter(x=>!isNaN(x.v));
    if(vals.length){ filled++; }
    if(!vals.length){ document.querySelector('.win-name[data-i="'+i+'"]').textContent='—';
      document.querySelector('.save[data-i="'+i+'"]').textContent=''; return; }
    vals.sort((a,b)=>a.v-b.v); const best=vals[0];
    const cell=document.querySelector('input.price[data-i="'+i+'"][data-s="'+best.s+'"]'); cell.parentElement.classList.add('win');
    const name = best.s==='mus'?'Musgrave':'Barry';
    document.querySelector('.win-name[data-i="'+i+'"]').textContent=name+' '+eur(best.v);
    const s = Math.max(0, d.main-best.v);
    document.querySelector('.save[data-i="'+i+'"]').textContent = s>0?('+'+eur(s)):'—';
    save+=s; base+=d.main;
  });
  document.getElementById('totSave').textContent=eur(save);
  document.getElementById('totBase').textContent=eur(base);
  document.getElementById('filled').textContent=filled+'/'+DATA.length;
}
document.addEventListener('input',e=>{ if(e.target.classList.contains('price')) recompute(); });
</script>
`);
