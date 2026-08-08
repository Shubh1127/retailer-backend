/**
 * Add-to-cart, end to end, across BOTH suppliers at once.
 *
 * Exercises the exact path the retailer's Add button takes — the same connector
 * calls `/api/cart/:supplier` dispatches to — for one Musgrave product and one
 * O'Reilly product in the same run.
 *
 * THE POINT IS THE CROSS-CHECK.
 *
 * Testing each supplier alone would not catch the failure that matters. The
 * cart UI held a single basket and an API that defaults to Musgrave, so an
 * O'Reilly row was looked up in — and would have been added to — the MUSGRAVE
 * basket. That is invisible when only one supplier is in play, and it buys the
 * wrong product at a real supplier when two are. So after adding, this asserts
 * BOTH that each product reached its own basket AND that neither product
 * appears in the other's.
 *
 * Touches real trade accounts, so it records what each basket looked like
 * before and puts it back afterwards — restoring a pre-existing line to its
 * original quantity rather than deleting something that was already there.
 *
 * Usage: npx tsx src/scripts/testBothCarts.ts [musgraveSku] [oreillySku] [qty]
 */

import 'dotenv/config';

import * as musgrave from '../services/musgraveCart.service.js';
import * as oreilly from '../services/oreillyCart.service.js';
import type { MusgraveBasket as Basket } from '../services/musgraveCart.service.js';

interface Connector {
  id: string;
  name: string;
  sku: string;
  getBasket(): Promise<Basket>;
  add(sku: string, quantity: number): Promise<{ failed: number; basket: Basket }>;
  setQuantity(basketItemId: string, quantity: number, sku: string): Promise<Basket>;
  remove(basketItemId: string): Promise<Basket>;
}

const MUSGRAVE_SKU = process.argv[2] ?? '936223';
const OREILLY_SKU = process.argv[3] ?? '048698';
const QUANTITY = Number(process.argv[4] ?? '1');

if (!Number.isInteger(QUANTITY) || QUANTITY < 1) {
  console.error('Quantity must be a whole number of 1 or more.');
  process.exit(1);
}

const CONNECTORS: Connector[] = [
  {
    id: 'musgrave',
    name: 'Musgrave',
    sku: MUSGRAVE_SKU,
    getBasket: musgrave.getCurrentBasket,
    add: async (sku, quantity) => {
      const result = await musgrave.addProducts([{ sku, quantity }]);
      return { failed: result.failed, basket: result.basket };
    },
    setQuantity: musgrave.updateQuantity,
    remove: musgrave.removeItem,
  },
  {
    id: 'oreilly',
    name: "O'Reilly",
    sku: OREILLY_SKU,
    getBasket: oreilly.getCurrentBasket,
    add: async (sku, quantity) => {
      const result = await oreilly.addProducts([{ sku, quantity }]);
      return { failed: result.failed, basket: result.basket };
    },
    setQuantity: (basketItemId, quantity) =>
      oreilly.updateQuantity(basketItemId, quantity),
    remove: oreilly.removeItem,
  },
];

let failures = 0;

function check(passed: boolean, description: string): void {
  if (!passed) failures += 1;
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${description}`);
}

function describe(basket: Basket): string {
  if (basket.isEmpty) return 'empty';
  return basket.lineItems
    .map((line) => `${line.sku}×${line.quantity}`)
    .join(', ');
}

// ---- 1. Snapshot ----------------------------------------------------------

console.log('\n=== BEFORE ===');
const before = new Map<string, Basket>();

for (const connector of CONNECTORS) {
  const basket = await connector.getBasket();
  before.set(connector.id, basket);
  console.log(`${connector.name}: ${describe(basket)}`);
}

// ---- 2. Add ---------------------------------------------------------------

console.log(`\n=== ADD (qty ${QUANTITY} each) ===`);

for (const connector of CONNECTORS) {
  const existing = before.get(connector.id)!.bySku[connector.sku];
  if (existing) {
    console.log(
      `${connector.name}: ${connector.sku} already present at qty ` +
        `${existing.quantity}; it will be restored afterwards.`,
    );
  }

  const { failed } = await connector.add(connector.sku, QUANTITY);
  console.log(`${connector.name}: add ${connector.sku} — failed=${failed}`);
  check(failed === 0, `${connector.name} reported no failures`);
}

// ---- 3. Verify, including the cross-check ---------------------------------

console.log('\n=== VERIFY ===');
const after = new Map<string, Basket>();

for (const connector of CONNECTORS) {
  after.set(connector.id, await connector.getBasket());
}

for (const connector of CONNECTORS) {
  const own = after.get(connector.id)!;
  const line = own.bySku[connector.sku];

  console.log(`\n${connector.name}: ${describe(own)}`);
  check(line !== undefined, `${connector.sku} is in the ${connector.name} basket`);
  if (line) {
    check(
      line.quantity === QUANTITY,
      `${connector.sku} is at qty ${QUANTITY} (got ${line.quantity})`,
    );
  }

  // The regression check: nobody else's product may have landed here.
  for (const other of CONNECTORS) {
    if (other.id === connector.id) continue;
    // Only meaningful when the codes differ — identical codes across suppliers
    // cannot be told apart by presence alone.
    if (other.sku === connector.sku) {
      console.log(
        `  SKIP  cross-check vs ${other.name}: both use code ${other.sku}`,
      );
      continue;
    }
    check(
      own.bySku[other.sku] === undefined,
      `${other.name}'s product ${other.sku} did NOT leak into ${connector.name}`,
    );
  }
}

// ---- 4. Restore -----------------------------------------------------------

console.log('\n=== RESTORE ===');

for (const connector of CONNECTORS) {
  const original = before.get(connector.id)!.bySku[connector.sku];
  const line = after.get(connector.id)!.bySku[connector.sku];

  if (!line) {
    console.log(`${connector.name}: nothing to undo — the add did not land.`);
    continue;
  }

  if (original) {
    const restored = await connector.setQuantity(
      line.basketItemId,
      original.quantity,
      connector.sku,
    );
    console.log(
      `${connector.name}: restored ${connector.sku} to qty ${original.quantity} — ` +
        describe(restored),
    );
    check(
      restored.bySku[connector.sku]?.quantity === original.quantity,
      `${connector.name} back at its original quantity`,
    );
  } else {
    const removed = await connector.remove(line.basketItemId);
    console.log(`${connector.name}: removed ${connector.sku} — ${describe(removed)}`);
    check(
      removed.bySku[connector.sku] === undefined,
      `${connector.name} no longer holds ${connector.sku}`,
    );
  }
}

// ---- 5. Result ------------------------------------------------------------

console.log(
  failures === 0
    ? '\nAll checks passed. Both baskets are back as they were.\n'
    : `\n${failures} check(s) FAILED — inspect the baskets by hand.\n`,
);

process.exit(failures === 0 ? 0 : 1);
