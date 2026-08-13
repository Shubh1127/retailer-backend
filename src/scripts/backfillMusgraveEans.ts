/**
 * Populate `musgrave_products.{ean, gtin14, additional_gtins}` from data the
 * catalogue already holds.
 *
 * MAKES NO MUSGRAVE REQUESTS. Every row's `raw_product` already carries
 * `attributeGroup.attributes[]` with `EANCode` and `AdditionalEAN` — the sync
 * has been storing them all along and simply never promoted them. This reads
 * this database and writes back to it.
 *
 * WHY THIS IS A SCRIPT AND NOT SQL IN THE MIGRATION
 *
 * A valid GTIN means the GS1 mod-10 check digit plus the restricted-prefix
 * rules, which already exist and are already tested in `src/gtin.ts`. Doing it
 * in plpgsql would be a second copy of that algorithm, free to drift from the
 * one the matching pipeline uses — and the two disagreeing about which barcodes
 * are real is exactly the failure this feature cannot survive.
 *
 * Idempotent. Safe to re-run, and safe to run against a partly-populated table:
 * it writes only rows whose stored values differ from what the parser derives.
 *
 *   npm run backfill:musgrave-eans           write
 *   npm run backfill:musgrave-eans -- --dry  report only, change nothing
 */

import 'dotenv/config';

import { getSupabaseClient } from '../db/supabase.js';
import { additionalGtins, toGtin14 } from '../services/musgraveProducts.parse.js';

const DRY_RUN = process.argv.includes('--dry');
const PAGE = 1000;
/** Rows per write. Large enough to be few round trips, small enough to retry. */
const WRITE_CHUNK = 500;

interface Row {
  id: number;
  sku: string;
  ean: string | null;
  gtin14: string | null;
  additional_gtins: string[] | null;
  attributeGroup: unknown;
}

/** Flatten the attribute bag, tolerating the object and array shapes alike. */
function attributesOf(group: unknown): { name?: string; value?: unknown }[] {
  if (!group) return [];
  if (Array.isArray(group)) {
    return group.flatMap((entry) => (entry as any)?.attributes ?? []);
  }
  return ((group as any).attributes ?? []) as { name?: string; value?: unknown }[];
}

function attribute(attrs: { name?: string; value?: unknown }[], name: string): unknown {
  const wanted = name.toLowerCase();
  return attrs.find((entry) => String(entry?.name ?? '').toLowerCase() === wanted)?.value;
}

/** Same array, same order, same members. */
function sameArray(a: string[] | null, b: string[]): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  return left.every((value, index) => value === b[index]);
}

const supabase = getSupabaseClient();

let scanned = 0;
let noBarcode = 0;
let invalid = 0;
let unchanged = 0;
let queued = 0;
let written = 0;
const invalidSamples: string[] = [];

type Update = {
  sku: string;
  ean: string | null;
  gtin14: string | null;
  additional_gtins: string[] | null;
};

const pending: Update[] = [];

async function flush(): Promise<void> {
  if (pending.length === 0 || DRY_RUN) {
    pending.length = 0;
    return;
  }

  // Keyed on SKU, not on the primary key.
  //
  // `musgrave_products.id` is `bigint generated always as identity`, and
  // GENERATED ALWAYS means Postgres rejects any supplied value outright — an
  // upsert that names `id` fails with "cannot insert a non-DEFAULT value into
  // column id" before it ever reaches the conflict clause.
  //
  // `sku` is the table's other unique column and is the sync's own conflict
  // target, so it is the right key here too. Every SKU written back was read
  // from this table a moment ago, so the conflict always fires and this is
  // always an UPDATE; the INSERT arm is unreachable. Columns absent from the
  // payload are left untouched by that update, which is what keeps a backfill
  // of three columns from blanking the other thirty.
  const chunk = pending.splice(0, pending.length);
  const { error } = await supabase
    .from('musgrave_products')
    .upsert(chunk, { onConflict: 'sku' });

  if (error) {
    throw new Error(`Write failed near sku ${chunk[0]?.sku}: ${error.message}`);
  }
  written += chunk.length;
}

console.log(DRY_RUN ? 'Musgrave EAN backfill (DRY RUN)' : 'Musgrave EAN backfill');
console.log('No supplier requests are made.\n');

let offset = 0;
for (;;) {
  const { data, error } = await supabase
    .from('musgrave_products')
    // Only the barcode-bearing slice of raw_product, not the whole blob — the
    // full document is ~4 KB a row and this walks every one of them.
    .select('id, sku, ean, gtin14, additional_gtins, raw_product->attributeGroup')
    .order('id', { ascending: true })
    .range(offset, offset + PAGE - 1);

  if (error) throw new Error(`Read failed at offset ${offset}: ${error.message}`);
  if (!data || data.length === 0) break;

  for (const row of data as unknown as Row[]) {
    scanned++;

    const attrs = attributesOf(row.attributeGroup);
    const rawEan = attribute(attrs, 'EANCode');
    const ean = rawEan == null ? null : String(rawEan).trim() || null;
    const gtin14 = toGtin14(ean) ?? null;
    const extra = additionalGtins(attribute(attrs, 'AdditionalEAN'), gtin14 ?? undefined);

    if (!ean) {
      noBarcode++;
    } else if (!gtin14) {
      invalid++;
      if (invalidSamples.length < 10) invalidSamples.push(`${row.sku}: "${ean}"`);
    }

    const same =
      row.ean === ean &&
      row.gtin14 === gtin14 &&
      sameArray(row.additional_gtins, extra);

    if (same) {
      unchanged++;
      continue;
    }

    queued++;
    pending.push({
      sku: row.sku,
      ean,
      gtin14,
      additional_gtins: extra.length > 0 ? extra : null,
    });

    if (pending.length >= WRITE_CHUNK) await flush();
  }

  if (scanned % 5000 < PAGE) {
    console.log(`  scanned ${scanned}…`);
  }

  offset += PAGE;
  if (data.length < PAGE) break;
}

await flush();

console.log('');
console.log(`rows scanned                 ${scanned}`);
console.log(`  already correct            ${unchanged}`);
console.log(`  ${DRY_RUN ? 'would write' : 'written    '}                ${DRY_RUN ? queued : written}`);
console.log('');
console.log(`no EANCode at all            ${noBarcode}`);
console.log(`EANCode present but invalid  ${invalid}   (stored verbatim, gtin14 left NULL)`);

if (invalidSamples.length > 0) {
  console.log('\nrejected samples:');
  for (const sample of invalidSamples) console.log(`  ${sample}`);
}

if (DRY_RUN) {
  console.log('\nDry run — nothing was written.');
}
