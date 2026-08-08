/**
 * Does the database have the columns the job writer expects?
 *
 * A persistence failure is best-effort and therefore silent to the user: the
 * run completes, the dashboard fills in, and only a log line says the history
 * was lost. This asks the question directly instead — one probe per column,
 * so a missing one names itself.
 *
 * Usage: npx tsx src/scripts/checkJobColumns.ts
 */

import 'dotenv/config';
import { getSupabaseClient } from '../db/supabase.js';

const EXPECTED: Record<string, string[]> = {
  processing_jobs: ['job_id', 'file_name', 'store_name', 'status', 'user_id'],
  // Every column `readyRecord` writes. Checked in full rather than spot-checked:
  // a partial list finds one missing column, and the next run finds the next.
  processed_products: [
    'job_id',
    'source_row',
    'article_code',
    'requested_product',
    'requested_pack',
    'cases',
    'supplier_id',
    'supplier_name',
    'selected_product',
    'supplier_sku',
    'ean',
    'ex_vat_case_price',
    'units_per_case',
    'unit_size',
    'uom',
    'savings',
    'savings_pct',
    'savings_basis',
    'baseline_cost',
    'cost_delta',
    'dashboard_status',
    'warnings',
    'admin_confirmed',
    'added_to_cart',
    'alternatives',
    'offers',
    'reconciliation',
    'judgements',
  ],
  attention_products: [
    'job_id',
    'source_row',
    'article_code',
    'requested_product',
    'status',
    'reason',
    'suggestion',
    'failure_codes',
    'diagnostics',
    'requested_pack',
    'cases',
  ],
  app_users: ['id', 'role', 'blocked', 'last_seen_at', 'precise_latitude'],
  user_sessions: ['user_id', 'ip', 'started_at'],
};

const db = getSupabaseClient();
let missing = 0;

for (const [table, columns] of Object.entries(EXPECTED)) {
  console.log(`\n${table}`);

  for (const column of columns) {
    // Selecting one column is the cheapest way to ask whether it exists —
    // PostgREST answers with a 42703 rather than a row.
    const { error } = await db.from(table).select(column).limit(1);

    if (!error) {
      console.log(`  ok       ${column}`);
      continue;
    }

    missing += 1;
    console.log(`  MISSING  ${column}  — ${error.message}`);
  }
}

if (missing > 0) {
  console.log(
    `\n${missing} column(s) unavailable. Apply the migrations in ` +
      'supabase/migrations in filename order, then reload the schema cache ' +
      '(Supabase → Settings → API → Reload).\n',
  );
  process.exit(1);
}

console.log('\nAll expected columns present.\n');
