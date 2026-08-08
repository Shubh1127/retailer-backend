/**
 * End-to-end demo: import two supplier price files → build a weekly list →
 * allocate across suppliers by the preference-band rule → reconcile a filled cart.
 * Run with: npm run demo
 */

import { importSupplierFile, type ColumnMapping } from './ingest/import.js';
import { prepareLine, type PrepareContext } from './allocation/offers.js';
import { allocate } from './allocation/engine.js';
import { reconcileCart, type IntendedLine } from './reconcile.js';
import { computeCheckDigit, normalizeToGtin14 } from './gtin.js';
import type { AllocationConfig, OrderRequestLine, Supplier } from './types.js';

// A scanned EAN-13 normalizes to the same canonical GTIN-14 the importer stores.
const ean = (b: string) => normalizeToGtin14(b + String(computeCheckDigit(b)));
const E_COLA = ean('500000000001');
const E_BEANS = ean('500000000002');
const E_OIL = ean('500000000003');

const MAPPING: ColumnMapping = {
  supplierSku: 'SKU', description: 'Description', unitGtin: 'EAN',
  unitsPerCase: 'CaseQty', unitSize: 'UnitSize', uom: 'UOM', casePrice: 'CasePrice',
  isPromo: 'Promo', promoEndDate: 'PromoEnd', isPmp: 'PMP', brand: 'Brand',
};

// Main supplier (Musgrave) export — VAT-exclusive prices.
const musgraveCsv = [
  'SKU,Description,EAN,CaseQty,UnitSize,UOM,CasePrice,Promo,PromoEnd,PMP,Brand',
  `M-COLA,Cola 24x330ml,${E_COLA},24,330,ml,12.00,0,,0,ColaCo`,
  `M-BEANS,Beans 12x400g,${E_BEANS},12,400,g,8.00,0,,0,BeanCo`,
  `M-OIL,Oil 12x1L,${E_OIL},12,1,l,20.00,0,,0,OilCo`,
].join('\n');

// Alternative supplier (Value Centre) export — VAT-inclusive prices @23%.
const valueCsv = [
  'SKU,Description,EAN,CaseQty,UnitSize,UOM,CasePrice,Promo,PromoEnd,PMP,Brand',
  `V-COLA,Cola 24x330ml,${E_COLA},24,330,ml,12.30,0,,0,ColaCo`, // ~10.0 ex-VAT → ~17% cheaper → divert
  `V-BEANS,Beans 12x400g,${E_BEANS},12,400,g,9.90,0,,0,BeanCo`, // ~8.05 ex-VAT → within band → main
  `V-OIL,Oil 12x1L,${E_OIL},12,1,l,18.45,1,2026-07-05,0,OilCo`, // promo LAPSED before order → falls back
].join('\n');

const capturedAt = '2026-07-08T02:00:00Z';
const musgrave = importSupplierFile(musgraveCsv, {
  supplierId: 'musgrave', mapping: MAPPING, capturedAt, defaultVatRate: 0.23, pricesVatInclusive: false,
});
const value = importSupplierFile(valueCsv, {
  supplierId: 'valuecentre', mapping: MAPPING, capturedAt, defaultVatRate: 0.23, pricesVatInclusive: true,
});

const suppliers: Supplier[] = [
  { id: 'musgrave', name: 'Musgrave MarketPlace', isMain: true, channel: 'quick-order-paste', minOrderValue: 0, deliveryFee: 0 },
  { id: 'valuecentre', name: 'Value Centre', isMain: false, channel: 'webview-cart', minOrderValue: 50, deliveryFee: 7.5 },
];

const config: AllocationConfig = { preferenceBand: 0.05, orderDate: '2026-07-09', outlierDeviation: 0.45 };

// The weekly order list the owner built by scanning.
const lines: OrderRequestLine[] = [
  { unitGtin: E_COLA, cases: 10 },
  { unitGtin: E_BEANS, cases: 8 },
  { unitGtin: E_OIL, cases: 4 },
];

const ctx: Omit<PrepareContext, 'suppliers'> = {
  matches: [...musgrave.matches, ...value.matches],
  quotes: [...musgrave.quotes, ...value.quotes],
  products: new Map([...musgrave.products, ...value.products].map((p) => [p.unitGtin, p])),
  config,
};
const supMap = new Map(suppliers.map((s) => [s.id, s]));
const inputs = lines.map((l) => prepareLine(l, { ...ctx, suppliers: supMap }));
const result = allocate(inputs, suppliers, config);

console.log('=== ALLOCATION ===');
for (const l of result.lines) {
  console.log(
    `${l.unitGtin}  ${l.status.padEnd(10)}  ${(l.supplierId ?? '-').padEnd(12)}` +
      `  case €${(l.exVatCasePrice ?? 0).toFixed(2)}  x${l.cases}` +
      `  ${l.divertedFromMain ? '(diverted)' : ''}  ${l.reason}`,
  );
}
console.log('\n=== BASKETS ===');
for (const b of result.baskets) {
  console.log(`${b.name.padEnd(22)} lines=${b.lineCount}  goods=€${b.goodsExVat.toFixed(2)}  delivery=€${b.deliveryFee.toFixed(2)}  minOK=${b.meetsMinOrder}`);
}
console.log('\n=== TOTALS ===');
console.log(`Goods ex-VAT:      €${result.totalGoodsExVat.toFixed(2)}`);
console.log(`Delivery:          €${result.totalDeliveryExVat.toFixed(2)}`);
console.log(`Grand total:       €${result.grandTotalExVat.toFixed(2)}`);
console.log(`All-from-main base:€${result.baselineAllFromMainExVat.toFixed(2)}`);
console.log(`Weekly saving:     €${result.totalSavingExVat.toFixed(2)}`);

// Simulate the assisted-fill read-back for the Value Centre basket.
const vLines = result.lines.filter((l) => l.supplierId === 'valuecentre');
const intended: IntendedLine[] = vLines.map((l) => ({
  supplierSku: l.supplierSku!, cases: l.cases, exVatCasePrice: l.exVatCasePrice!,
}));
// Pretend the cart came back with the right qty but a price that drifted up 6%.
const cart = intended.map((i) => ({ supplierSku: i.supplierSku, cases: i.cases, exVatCasePrice: i.exVatCasePrice * 1.06 }));
const recon = reconcileCart(intended, cart);
console.log('\n=== CART READ-BACK (Value Centre) ===');
for (const l of recon.lines) console.log(`${l.supplierSku}  ${l.status.toUpperCase()}  ${l.reasons.join(' ')}`);
console.log(`green=${recon.green} amber=${recon.amber} red=${recon.red}  pickList=[${recon.pickList.join(', ')}]`);
