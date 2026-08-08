/**
 * Sync the Musgrave category hierarchy into Supabase.
 *
 * Usage:
 *   npm run sync:categories                    # fetch → parse → write
 *   npm run sync:categories -- --dry-run       # fetch → parse, write nothing
 *   npm run sync:categories -- --dump raw.json # save the raw API response only
 *   npm run sync:categories -- --limit 5       # override the endpoint's limit
 *
 * Needs MUSGRAVE_EMAIL / MUSGRAVE_PASSWORD, plus SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY unless running with --dry-run or --dump.
 *
 * Start with `--dump` on a new environment: it captures exactly what the endpoint
 * returns, which is the fastest way to confirm the response envelope before
 * anything is written.
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fetchMusgraveCategoryTree } from '../services/musgraveCategories.api.js';
import { syncMusgraveCategories } from '../services/musgraveCategories.sync.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const dryRun = args.includes('--dry-run');
const dumpPath = flag('dump');
const limit = flag('limit');
const query: Record<string, string> = limit ? { limit } : {};

if (dumpPath) {
  const response = await fetchMusgraveCategoryTree(query);
  writeFileSync(dumpPath, JSON.stringify(response.data, null, 2), 'utf8');
  console.log(`\nRaw category response written to ${dumpPath}`);
  console.log(`  spgid: ${response.spgid}`);
  console.log(`  url:   ${response.url}\n`);
} else {
  const result = await syncMusgraveCategories({ dryRun, query });

  console.log(`\n${result.dryRun ? 'Dry run' : `Sync #${result.syncRunId}`} complete`);
  console.log(`  spgid       : ${result.spgid}`);
  console.log(`  categories  : ${result.categories}  (max depth ${result.maxDepth})`);
  console.log(`  attributes  : ${result.attributes}`);
  console.log(`  paths       : ${result.paths}`);
  if (!result.dryRun) {
    console.log(`  deactivated : ${result.categoriesDeactivated}`);
  }
  console.log(`  duration    : ${result.durationMs} ms`);

  if (result.warnings.length > 0) {
    console.log(`\n  ${result.warnings.length} warning(s):`);
    for (const warning of result.warnings.slice(0, 20)) console.log(`    - ${warning}`);
    if (result.warnings.length > 20) {
      console.log(`    … and ${result.warnings.length - 20} more`);
    }
  }
  console.log('');
}
