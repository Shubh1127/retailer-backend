/**
 * Verify the Supabase connection and that the Musgrave schema is in place.
 *
 * Usage: npm run db:check
 *
 * Exits 0 when every expected table answers, 1 otherwise — so it can gate a
 * deploy or a sync run.
 */

import 'dotenv/config';
import {
  ensureSupabaseStartupCheck,
  formatSupabaseError,
  verifySupabaseTables,
} from '../db/health.js';

const connection = await ensureSupabaseStartupCheck();

console.log('');
console.log('Tables');

const results = await verifySupabaseTables();

for (const result of results) {
  if (result.ok) {
    console.log(`  ✅ ${result.table.padEnd(30)} ${result.count} row(s)`);
  } else {
    console.log(`  ❌ ${result.table.padEnd(30)} ${result.error?.code ?? 'error'}`);
  }
}

const missing = results.filter((r) => !r.ok);

if (missing.length > 0) {
  console.log('');
  for (const result of missing) {
    console.log(`${result.table}:`);
    console.log(formatSupabaseError(result.error ?? { message: 'Unknown error' }));
    console.log('');
  }
  console.log(
    `${missing.length} of ${results.length} table(s) unavailable. If they are all missing, the` +
      ' migration has not been applied: run supabase/migrations/20260730120000_musgrave_categories.sql' +
      " against the project, then reload the schema cache (Settings → API → Reload).",
  );
  process.exit(1);
}

console.log('');
console.log(`✅ Schema verified — ${results.length} tables present.`);

if (!connection.ok) process.exit(1);
