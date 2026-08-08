/**
 * End-to-end check of the Musgrave cart integration against the live basket.
 *
 *   npx tsx src/scripts/testMusgraveCart.ts [sku]
 *
 * Adds one product, reads it back, bumps the quantity, then removes it — so the
 * basket ends as it started. Every step prints what came back, because the
 * whole point is to confirm the parsing matches the real API rather than the
 * one we imagined.
 *
 * It only ever removes the line IT added. Anything already in the basket is
 * left alone.
 */

import 'dotenv/config';
import {
  addProducts,
  getCurrentBasket,
  removeItem,
  updateQuantity,
  validateBasket,
} from '../services/musgraveCart.service.js';

const SKU = process.argv[2] ?? '936223'; // Coca Cola Can, from the captured request

function line(label: string): void {
  console.log(`\n${'-'.repeat(64)}\n${label}\n${'-'.repeat(64)}`);
}

async function main(): Promise<void> {
  line('1. Basket before');
  const before = await getCurrentBasket();
  console.log(`  basketId : ${before.basketId ?? '(none)'}`);
  console.log(`  isEmpty  : ${before.isEmpty}`);
  console.log(`  lines    : ${before.lineItems.length}`);
  console.log(`  totals   :`, before.totals);
  for (const item of before.lineItems) {
    console.log(
      `    ${item.sku.padEnd(9)} ${(item.name ?? '').slice(0, 32).padEnd(34)} ` +
        `qty ${item.quantity} ${item.quantityUnit ?? ''}  net €${item.totalPrice ?? '—'}`,
    );
  }

  const alreadyThere = Boolean(before.bySku[SKU]);
  if (alreadyThere) {
    console.log(`\n  NOTE: ${SKU} is already in the basket — it will be left as found.`);
  }

  line(`2. Add ${SKU}`);
  const add = await addProducts([{ sku: SKU, quantity: 1, name: 'test line' }]);
  console.log(`  added=${add.added} updated=${add.updated} failed=${add.failed} skipped=${add.skipped}`);
  for (const result of add.results) {
    console.log(
      `    ${result.sku} → ${result.outcome}` +
        (result.basketItemId ? `  id=${result.basketItemId}` : '') +
        (result.error ? `  (${result.error})` : ''),
    );
  }

  const added = add.basket.bySku[SKU];
  if (!added) {
    console.error('\n  The line is not in the basket. Stopping before any cleanup.');
    process.exit(1);
  }

  console.log(`\n  line item as parsed:`);
  console.dir(added, { depth: 3 });
  console.log(`  basket totals:`, add.basket.totals);

  line('3. Set quantity to 2');
  const bumped = await updateQuantity(added.basketItemId, 2, SKU);
  console.log(`  quantity now: ${bumped.bySku[SKU]?.quantity}`);
  console.log(`  totals:`, bumped.totals);

  line('4. Validate');
  const validation = await validateBasket();
  console.log(`  valid: ${validation.valid}`);
  for (const message of validation.messages) {
    console.log(`    [${message.severity}] ${message.message}`);
  }

  line('5. Cleanup');
  if (alreadyThere) {
    console.log('  restoring the original quantity rather than deleting');
    await updateQuantity(added.basketItemId, before.bySku[SKU]!.quantity, SKU);
  } else {
    await removeItem(added.basketItemId);
    console.log('  removed the test line');
  }

  const after = await getCurrentBasket();
  console.log(`  lines now: ${after.lineItems.length} (was ${before.lineItems.length})`);
  console.log(
    after.lineItems.length === before.lineItems.length
      ? '  basket restored'
      : '  !! basket NOT restored — check it on the Musgrave site',
  );
}

main().catch((error) => {
  console.error('\nFAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
