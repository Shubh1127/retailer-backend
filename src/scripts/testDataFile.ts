/**
 * Locate a retailer order file in backend/test-data/.
 *
 * Shared by the validation harnesses so they resolve input identically.
 */

import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

export const TEST_DATA_DIR = 'test-data';

const ACCEPTED_EXTENSIONS = new Set(['.xls', '.xlsx', '.csv']);

/** The explicit path if given, else the first order file in test-data/. */
export function resolveTestDataFile(explicitPath?: string): string {
  if (explicitPath) return explicitPath;

  let entries: string[];
  try {
    entries = readdirSync(TEST_DATA_DIR);
  } catch {
    throw new Error(
      `No ${TEST_DATA_DIR}/ directory found. Create it and drop a retailer order file in.`,
    );
  }

  const candidates = entries
    .filter((name) => ACCEPTED_EXTENSIONS.has(extname(name).toLowerCase()))
    .filter((name) => !name.startsWith('~$')) // Excel lock files
    .sort();

  const first = candidates[0];
  if (!first) {
    throw new Error(
      `No .xls/.xlsx/.csv file in ${TEST_DATA_DIR}/. Drop a retailer order file there first.`,
    );
  }

  if (candidates.length > 1) {
    console.log(`Note: ${candidates.length} files present, using the first (${first}).`);
    console.log('      Use --file to pick another.\n');
  }

  return join(TEST_DATA_DIR, first);
}
