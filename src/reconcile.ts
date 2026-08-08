/**
 * Cart read-back reconciliation.
 *
 * After assisted-fill pastes a SKU+qty list into a supplier's bulk-order box, the
 * app reads the resulting cart back and diffs it against what the allocation
 * intended. A line is GREEN only if ALL hold:
 *   1. the SKU is present in the cart,
 *   2. the cart quantity (in cases) matches intent — catches a bulk box that
 *      silently rounds/rejects a case multiple,
 *   3. the cart's unit price is within tolerance of the ex-VAT basis that won the
 *      line its award — catches a lapsed promo or a price that moved since sync.
 * Anything else is AMBER (needs attention) or RED (missing / wrong), and drops to
 * a pick list. It must NEVER go green on presence alone.
 */

export type ReconcileStatus = 'green' | 'amber' | 'red';

/** What we intended to order for one line (from the allocation). */
export interface IntendedLine {
  supplierSku: string;
  cases: number;
  /** The ex-VAT case price that won this line the award. */
  exVatCasePrice: number;
}

/** What the supplier cart actually shows for a SKU after fill. */
export interface CartLine {
  supplierSku: string;
  /** Quantity the cart shows, in cases. Undefined if the SKU isn't in the cart. */
  cases?: number;
  /** Ex-VAT case price the cart shows. Undefined if unknown. */
  exVatCasePrice?: number;
}

export interface ReconcileLine {
  supplierSku: string;
  status: ReconcileStatus;
  intendedCases: number;
  cartCases?: number;
  intendedPrice: number;
  cartPrice?: number;
  /** Signed price drift as a fraction of the intended price (cart/intended - 1). */
  priceDriftPct?: number;
  reasons: string[];
}

export interface ReconcileReport {
  lines: ReconcileLine[];
  green: number;
  amber: number;
  red: number;
  /** SKUs to move to a pick list (anything not green). */
  pickList: string[];
  allGreen: boolean;
}

export interface ReconcileOptions {
  /** Max allowed price drift as a fraction before a line goes amber. Default 0.02 (2%). */
  priceTolerance?: number;
}

export function reconcileCart(
  intended: IntendedLine[],
  cart: CartLine[],
  opts: ReconcileOptions = {},
): ReconcileReport {
  const tol = opts.priceTolerance ?? 0.02;
  const cartBySku = new Map(cart.map((c) => [c.supplierSku, c]));
  const lines: ReconcileLine[] = [];

  for (const want of intended) {
    const got = cartBySku.get(want.supplierSku);
    const reasons: string[] = [];
    let status: ReconcileStatus = 'green';

    if (!got || got.cases === undefined || got.cases === 0) {
      status = 'red';
      reasons.push('SKU not present in cart after fill.');
      lines.push({
        supplierSku: want.supplierSku,
        status,
        intendedCases: want.cases,
        intendedPrice: want.exVatCasePrice,
        reasons,
      });
      continue;
    }

    if (got.cases !== want.cases) {
      status = 'red';
      reasons.push(`Quantity mismatch: intended ${want.cases} case(s), cart has ${got.cases}.`);
    }

    let driftPct: number | undefined;
    if (got.exVatCasePrice === undefined) {
      status = status === 'red' ? 'red' : 'amber';
      reasons.push('Cart did not expose a price to verify against the winning basis.');
    } else {
      driftPct = got.exVatCasePrice / want.exVatCasePrice - 1;
      if (Math.abs(driftPct) > tol) {
        // A price that moved beyond tolerance never counts as green.
        status = status === 'red' ? 'red' : 'amber';
        reasons.push(
          `Price drift ${(driftPct * 100).toFixed(1)}% vs winning basis €${want.exVatCasePrice.toFixed(2)} (cart €${got.exVatCasePrice.toFixed(2)}). Re-run allocation on cart price.`,
        );
      }
    }

    if (status === 'green') reasons.push('SKU, quantity and price all match intent.');

    lines.push({
      supplierSku: want.supplierSku,
      status,
      intendedCases: want.cases,
      cartCases: got.cases,
      intendedPrice: want.exVatCasePrice,
      ...(got.exVatCasePrice !== undefined ? { cartPrice: got.exVatCasePrice } : {}),
      ...(driftPct !== undefined ? { priceDriftPct: driftPct } : {}),
      reasons,
    });
  }

  const green = lines.filter((l) => l.status === 'green').length;
  const amber = lines.filter((l) => l.status === 'amber').length;
  const red = lines.filter((l) => l.status === 'red').length;
  const pickList = lines.filter((l) => l.status !== 'green').map((l) => l.supplierSku);

  return { lines, green, amber, red, pickList, allGreen: amber === 0 && red === 0 };
}
