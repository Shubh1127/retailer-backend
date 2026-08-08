/**
 * What is actually stored in the O'Reilly catalogue tables.
 *
 * The sync's own counters say what it BELIEVES it wrote. This reads the rows
 * back, which is a different claim — and the one that matters.
 *
 * Read-only.
 */

import 'dotenv/config';
import { getSupabaseClient } from '../db/supabase.js';

const supabase = getSupabaseClient();

const { count: total } = await supabase
  .from('oreilly_products')
  .select('id', { count: 'exact', head: true });

const { count: withEan } = await supabase
  .from('oreilly_products')
  .select('id', { count: 'exact', head: true })
  .not('ean', 'is', null);

const { count: pending } = await supabase
  .from('oreilly_products')
  .select('id', { count: 'exact', head: true })
  .is('details_fetched_at', null);

const { count: failed } = await supabase
  .from('oreilly_products')
  .select('id', { count: 'exact', head: true })
  .not('details_error', 'is', null);

const { count: categories } = await supabase
  .from('oreilly_categories')
  .select('id', { count: 'exact', head: true });

const { count: memberships } = await supabase
  .from('oreilly_product_categories')
  .select('product_id', { count: 'exact', head: true });

console.log(`products            ${total}`);
console.log(`  with an EAN       ${withEan}`);
console.log(`  awaiting details  ${pending}`);
console.log(`  detail failures   ${failed}`);
console.log(`categories          ${categories}`);
console.log(`memberships         ${memberships}`);

const { data: sample } = await supabase
  .from('oreilly_products')
  .select(
    'product_code, name, price, rrp, por_pct, vat_rate, ean, units_per_case, unit_size, uom, size_text, image_url, details_fetched_at',
  )
  .order('product_code')
  .limit(4);

console.log('\nsample rows:');
for (const row of (sample ?? []) as Record<string, any>[]) {
  console.log(`\n  ${row.product_code}  ${row.name}`);
  console.log(
    `    price ${row.price}  rrp ${row.rrp}  por ${row.por_pct}%  vat ${row.vat_rate}`,
  );
  console.log(
    `    ean ${row.ean ?? '(none)'}  pack ${row.units_per_case ?? '—'}  ` +
      `size ${row.unit_size ?? '—'}${row.uom ?? ''} ("${row.size_text ?? ''}")`,
  );
  console.log(`    details read at ${row.details_fetched_at ?? 'NOT YET'}`);
}

// Leading zeros are the thing most likely to have been silently destroyed.
const { data: zeroPadded } = await supabase
  .from('oreilly_products')
  .select('product_code')
  .like('product_code', '0%')
  .limit(3);

console.log(
  `\nleading-zero codes preserved: ${
    (zeroPadded ?? []).map((r: Record<string, any>) => r.product_code).join(', ') || '(none found)'
  }`,
);

const { data: runs } = await supabase
  .from('oreilly_product_sync_runs')
  .select('id, status, products_inserted, details_succeeded, throttle_events, reauth_events')
  .order('id', { ascending: false })
  .limit(3);

console.log('\nrecent sync runs:');
for (const run of (runs ?? []) as Record<string, any>[]) {
  console.log(
    `  #${run.id} ${run.status} — inserted ${run.products_inserted}, ` +
      `details ${run.details_succeeded}, throttles ${run.throttle_events}, ` +
      `reauths ${run.reauth_events}`,
  );
}
