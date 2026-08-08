/**
 * Seed the store from the sample supplier CSVs so `npm run serve` has data to
 * allocate immediately. Run with: npm run seed
 */

import { readFile } from 'node:fs/promises';
import { Store, JsonFilePersistence, defaultSuppliers } from './store.js';
import { importSupplierFile, type ColumnMapping } from './ingest/import.js';

const MAPPING: ColumnMapping = {
  supplierSku: 'SKU', description: 'Description', unitGtin: 'EAN',
  unitsPerCase: 'CaseQty', unitSize: 'UnitSize', uom: 'UOM', casePrice: 'CasePrice',
  vatRate: 'VatRate', isPromo: 'Promo', promoEndDate: 'PromoEnd', isPmp: 'PMP',
  isOwnBrand: 'OwnBrand', brand: 'Brand',
};

const FILES: { supplierId: string; path: string; vatInclusive: boolean }[] = [
  { supplierId: 'musgrave', path: 'samples/musgrave.csv', vatInclusive: false },
  { supplierId: 'valuecentre', path: 'samples/valuecentre.csv', vatInclusive: true },
  { supplierId: 'barrygroup', path: 'samples/barrygroup.csv', vatInclusive: false },
];

const DATA_PATH = process.env.STORE_PATH ?? 'data/store.json';
const store = await Store.open(new JsonFilePersistence(DATA_PATH));
await store.setSuppliers(defaultSuppliers());

for (const f of FILES) {
  const csv = await readFile(f.path, 'utf8');
  const result = importSupplierFile(csv, {
    supplierId: f.supplierId,
    mapping: MAPPING,
    capturedAt: '2026-07-08T02:00:00Z',
    defaultVatRate: 0.23,
    pricesVatInclusive: f.vatInclusive,
  });
  await store.mergeImport({ products: result.products, matches: result.matches, quotes: result.quotes });
  console.log(`Seeded ${f.supplierId}: ${result.matches.length} matches, ${result.quotes.length} quotes`);
}
console.log(`Store written to ${DATA_PATH}. Start the API with:  npm run serve`);
