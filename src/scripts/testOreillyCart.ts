/**
 * Live round trip against the O'Reilly basket.
 *
 * Touches a real trade account, so it ends by putting the basket back exactly
 * as it found it.
 *
 * Order is remove-then-add rather than add-then-remove on purpose: when the
 * product is ALREADY in the basket, adding takes the `update.asp` branch and
 * never exercises `AddLine.asp` at all. Removing first guarantees both paths
 * run — and if it was the only line, it exercises the empty-basket parse too,
 * which is the case that previously threw.
 *
 * Usage: npx tsx src/scripts/testOreillyCart.ts [productCode]
 */

import 'dotenv/config';

import {
  addProducts,
  getCurrentBasket,
  removeItem,
  type SupplierBasket,
} from '../services/oreillyCart.service.js';

const SKU = process.argv[2] ?? '048698';

function show(label: string, basket: SupplierBasket): void {
  console.log(`\n--- ${label} ---`);
  console.log(`empty: ${basket.isEmpty}  lines: ${basket.lineItems.length}`);
  for (const line of basket.lineItems) {
    console.log(
      `  [${line.basketItemId}] ${line.sku}  qty=${line.quantity}  ` +
        `${line.singleBasePrice ?? '?'} ea  total=${line.totalPrice ?? '?'}  ` +
        `${line.quantityUnit ?? ''}  ${line.name ?? ''}`,
    );
  }
  console.log(`totals: ${JSON.stringify(basket.totals)}`);
}

const before = await getCurrentBasket();
show('BEFORE', before);

const original = before.bySku[SKU];
const targetQuantity = original?.quantity ?? 1;

// ---- 1. Remove -----------------------------------------------------------
if (original) {
  console.log(`\n[1] Removing line ${original.basketItemId} (${SKU}) …`);
  const removed = await removeItem(original.basketItemId);
  show('AFTER REMOVE', removed);
  console.log(
    removed.bySku[SKU]
      ? 'FAIL: still present after remove.'
      : 'PASS: gone after remove.',
  );
} else {
  console.log(`\n[1] ${SKU} is not in the basket — nothing to remove.`);
}

// ---- 2. Add --------------------------------------------------------------
console.log(`\n[2] Adding ${SKU} × ${targetQuantity} via AddLine.asp …`);
const result = await addProducts([{ sku: SKU, quantity: targetQuantity }]);
console.log(
  `outcomes: added=${result.added} updated=${result.updated} ` +
    `failed=${result.failed} skipped=${result.skipped}`,
);
console.log(JSON.stringify(result.results, null, 2));
show('AFTER ADD', result.basket);

const line = result.basket.bySku[SKU];
console.log(
  line && line.quantity === targetQuantity
    ? `PASS: present at qty ${line.quantity}.`
    : `FAIL: expected qty ${targetQuantity}, got ${line?.quantity ?? 'absent'}.`,
);

console.log('\nBasket restored to its starting state.');
