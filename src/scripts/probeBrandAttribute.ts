/**
 * One-off probe: does the Musgrave product element carry a CONSUMER BRAND
 * distinct from `manufacturer`?
 *
 * This matters because manufacturer and brand are different business entities —
 * Ferrero makes Kinder, Mondelez makes Cadbury — and training a model to call
 * the manufacturer the brand teaches it something false that gets expensive to
 * unlearn. If the API already states a brand, it is the strongest signal
 * available and belongs in the export; if it does not, the dataset builder has
 * to derive the brand from titles instead.
 *
 * Run:  npx tsx src/scripts/probeBrandAttribute.ts
 */

import 'dotenv/config';
import { getSupabaseClient } from '../db/supabase.js';
import { indexAttributes, type MusgraveApiProduct } from '../services/musgraveProducts.parse.js';

const SAMPLE = 400;

async function main(): Promise<void> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('musgrave_products')
    .select('sku, name, manufacturer, raw_product')
    .not('raw_product', 'is', null)
    .limit(SAMPLE);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { sku: string; name: string; manufacturer?: string; raw_product: unknown }[];

  const attributeNames = new Map<string, number>();
  const brandLike: { sku: string; name: string; manufacturer?: string; key: string; value: unknown }[] = [];

  for (const row of rows) {
    const attributes = indexAttributes(row.raw_product as MusgraveApiProduct);
    for (const [key, value] of attributes) {
      attributeNames.set(key, (attributeNames.get(key) ?? 0) + 1);
      if (/brand/i.test(key) && value != null && String(value).trim() !== '') {
        brandLike.push({
          sku: row.sku,
          name: row.name,
          ...(row.manufacturer ? { manufacturer: row.manufacturer } : {}),
          key,
          value,
        });
      }
    }
  }

  console.log(`Sampled ${rows.length} products with a raw element.\n`);
  console.log('Every attribute name seen, with how many products carry it:');
  for (const [key, count] of [...attributeNames].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(34)} ${count}`);
  }

  console.log(`\nAttributes whose NAME mentions "brand": ${brandLike.length} occurrence(s)`);
  for (const hit of brandLike.slice(0, 25)) {
    console.log(
      `  ${hit.key} = ${JSON.stringify(hit.value)}  |  name=${hit.name}  manufacturer=${hit.manufacturer ?? '—'}`,
    );
  }

  // Where a brand-ish attribute exists, does it ever DISAGREE with the
  // manufacturer? Agreement everywhere would mean it is the same field under
  // another name and buys us nothing.
  const disagreements = brandLike.filter(
    (hit) =>
      hit.manufacturer &&
      String(hit.value).trim().toLowerCase() !== hit.manufacturer.trim().toLowerCase(),
  );
  console.log(
    `\nOf those, ${disagreements.length} disagree with the manufacturer column ` +
      '(a brand field that always agrees is just the manufacturer renamed).',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
