/**
 * Matching policy configuration.
 *
 * Loads `config/matching.json` — the business rules for what counts as an
 * acceptable candidate and which supplier wins a line. Kept apart from the
 * normalization vocabulary: that says what words mean, this says what the
 * business will accept.
 *
 * Same failure posture as the normalization config: a missing or broken file
 * falls back to the documented defaults rather than stopping a retailer
 * processing an order.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../log.js';

const log = createLogger('matching-config');

export interface MatchingConfig {
  supplierSelection: {
    /** Prices within this many euro are "effectively equal" — preference decides. */
    priceTieToleranceEur: number;
    /** Supplier ids, most preferred first. Used only to break a price tie. */
    preferenceOrder: string[];
  };
  unitSize: {
    /**
     * How far the unit size may differ, when units-per-case is identical,
     * before it stops being a warning and becomes a hard mismatch.
     */
    nearMatchPct: number;
  };
  /**
   * What a pack-size difference does once the product identity matches.
   * 'warn' lets the line reach Ready To Order with the difference stated;
   * 'reject' sends it to Needs Attention.
   */
  packDifference: 'warn' | 'reject';
}

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  supplierSelection: { priceTieToleranceEur: 0.05, preferenceOrder: ['musgrave', 'oreilly'] },
  unitSize: { nearMatchPct: 0.25 },
  packDifference: 'warn',
};

let cached: MatchingConfig | null = null;

function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'config', 'matching.json');
}

export function getMatchingConfig(): MatchingConfig {
  if (cached) return cached;

  const path = resolve(process.env.MATCHING_CONFIG_PATH ?? defaultConfigPath());

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MatchingConfig>;
    cached = {
      supplierSelection: {
        ...DEFAULT_MATCHING_CONFIG.supplierSelection,
        ...(raw.supplierSelection ?? {}),
      },
      unitSize: { ...DEFAULT_MATCHING_CONFIG.unitSize, ...(raw.unitSize ?? {}) },
      packDifference: raw.packDifference ?? DEFAULT_MATCHING_CONFIG.packDifference,
    };
    return cached;
  } catch (error) {
    log.warn('Matching config unavailable — using defaults', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    cached = DEFAULT_MATCHING_CONFIG;
    return cached;
  }
}

export function setMatchingConfig(config: Partial<MatchingConfig>): void {
  cached = { ...getMatchingConfig(), ...config };
}

export function resetMatchingConfig(): void {
  cached = null;
}
