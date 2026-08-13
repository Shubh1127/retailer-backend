import "dotenv/config";
import { getSupabaseClient } from "./src/db/supabase.js";
import { normalizeToGtin14 } from "./src/gtin.js";
const s = getSupabaseClient();

const PAGE = 1000;
let from = 0;
let total = 0, hasGroup = 0, hasEanCode = 0, validEan = 0, rejected = 0, hasAdditional = 0;
const badSamples: string[] = [];
const lenHist = new Map<number, number>();

for (;;) {
  const { data, error } = await s
    .from("musgrave_products")
    .select("sku, raw_product->attributeGroup")
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) { console.log("ERR", error.message); break; }
  if (!data || data.length === 0) break;

  for (const row of data as any[]) {
    total++;
    const g = row.attributeGroup;
    if (!g) continue;
    hasGroup++;
    const attrs: any[] = Array.isArray(g) ? g.flatMap((x:any)=>x?.attributes ?? []) : (g.attributes ?? []);
    const ean = attrs.find((a:any)=>a?.name === "EANCode")?.value;
    const add = attrs.find((a:any)=>a?.name === "AdditionalEAN")?.value;
    if (Array.isArray(add) && add.length) hasAdditional++;
    if (ean == null || String(ean).trim() === "") continue;
    hasEanCode++;
    const raw = String(ean).trim();
    lenHist.set(raw.length, (lenHist.get(raw.length) ?? 0) + 1);
    try { normalizeToGtin14(raw); validEan++; }
    catch (e:any) { rejected++; if (badSamples.length < 8) badSamples.push(row.sku + ': "' + raw + '" -- ' + String(e.message).slice(0,55)); }
  }
  from += PAGE;
  if (data.length < PAGE) break;
}

const pct = (n:number)=>((n/total)*100).toFixed(1)+"%";
console.log("total rows scanned        " + total);
console.log("has attributeGroup        " + hasGroup + "  " + pct(hasGroup));
console.log("has non-empty EANCode     " + hasEanCode + "  " + pct(hasEanCode));
console.log("   passes normalizeToGtin14  " + validEan + "  " + pct(validEan));
console.log("   rejected                  " + rejected + "  " + pct(rejected));
console.log("has AdditionalEAN list    " + hasAdditional + "  " + pct(hasAdditional));
console.log("");
console.log("EANCode raw length histogram:");
[...lenHist.entries()].sort((a,b)=>a[0]-b[0]).forEach(([len,n])=>console.log("  " + String(len).padStart(3) + " digits  " + n));
console.log("");
console.log("rejected samples:");
badSamples.forEach(x=>console.log("  "+x));
