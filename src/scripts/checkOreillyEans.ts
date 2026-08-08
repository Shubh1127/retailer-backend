/**
 * EAN coverage, per department.
 *
 * A catalogue-wide percentage hides the thing that matters: whether a shortfall
 * is spread evenly (products that genuinely have no barcode) or concentrated in
 * one department (a crawl that did not finish, or a page shape the parser
 * mishandles). Those need different responses, so they are reported apart.
 *
 * Read-only.
 */

import 'dotenv/config';
import { getSupabaseClient } from '../db/supabase.js';

const supabase = getSupabaseClient();

const { data: categories } = await supabase
  .from('oreilly_categories')
  .select('dept_code, name')
  .eq('prod_group', 0)
  .order('dept_code');

let totalAll = 0;
let eanAll = 0;
let pendingAll = 0;

console.log('department            total   with EAN    %   pending  no-EAN');
console.log('─'.repeat(68));

for (const category of (categories ?? []) as Record<string, any>[]) {
  const dept = Number(category.dept_code);

  const count = async (build: (q: any) => any): Promise<number> => {
    const query = build(
      supabase
        .from('oreilly_products')
        .select('id', { count: 'exact', head: true })
        .eq('dept_code', dept),
    );
    const { count: n } = await query;
    return n ?? 0;
  };

  const total = await count((q: any) => q);
  const withEan = await count((q: any) => q.not('ean', 'is', null));
  const pending = await count((q: any) => q.is('details_fetched_at', null));
  // Read, but the page stated no barcode — a real answer, not a gap.
  const noEan = await count((q: any) =>
    q.is('ean', null).not('details_fetched_at', 'is', null),
  );

  totalAll += total;
  eanAll += withEan;
  pendingAll += pending;

  const pct = total > 0 ? ((withEan / total) * 100).toFixed(1) : '—';
  console.log(
    `${String(category.name).padEnd(20)} ${String(total).padStart(5)}   ` +
      `${String(withEan).padStart(7)} ${String(pct).padStart(5)}   ` +
      `${String(pending).padStart(7)} ${String(noEan).padStart(7)}`,
  );
}

console.log('─'.repeat(68));
console.log(
  `${'TOTAL'.padEnd(20)} ${String(totalAll).padStart(5)}   ` +
    `${String(eanAll).padStart(7)} ` +
    `${(totalAll > 0 ? ((eanAll / totalAll) * 100).toFixed(1) : '—').padStart(5)}   ` +
    `${String(pendingAll).padStart(7)}`,
);

const { count: failures } = await supabase
  .from('oreilly_products')
  .select('id', { count: 'exact', head: true })
  .not('details_error', 'is', null);

console.log(`\ndetail fetch failures: ${failures ?? 0}`);
