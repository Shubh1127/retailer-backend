/**
 * Do supplier searches actually come back with usable image URLs?
 *
 * Read-only: it searches and prints, and changes nothing. Checks both the
 * extraction (is there an image at all) and the scheme (is it https, since an
 * http URL is blocked outright on an https page).
 *
 * Usage: npx tsx src/scripts/testSupplierImages.ts [query]
 */

import 'dotenv/config';

import { searchAllSuppliers } from '../services/supplierSearch.js';

const query = process.argv[2] ?? 'coke';

const result = await searchAllSuppliers(query);

for (const error of result.errors) {
  console.log(`ERROR ${error.supplierId}: ${error.message}`);
}

for (const [supplier, hits] of result.hits) {
  const withImage = hits.filter((hit) => hit.card.imageUrl).length;
  const insecure = hits.filter((hit) =>
    hit.card.imageUrl?.startsWith('http://'),
  ).length;

  console.log(
    `\n${supplier}: ${hits.length} hits, ${withImage} with an image, ` +
      `${insecure} still http (must be 0)`,
  );

  for (const hit of hits.slice(0, 5)) {
    console.log(`  ${hit.card.supplierSku}  ${hit.card.name.slice(0, 40)}`);
    console.log(`    ${hit.card.imageUrl ?? '(no image)'}`);
  }
}
