/** Scratch probe: what does a supplier actually return for one query? */
import 'dotenv/config';
import { searchOreilly } from '../services/oreilly.service.js';
import { searchMusgrave } from '../services/musgrave.service.js';
import { candidateFromCard } from '../services/ruleEngine.js';
import { toExVat } from '../pricing/normalize.js';
import { commercialIdentity } from '../services/commercialEquivalence.js';

const query = process.argv[2] ?? 'SNICKERS';
const supplier = process.argv[3] ?? 'oreilly';

const hits =
  supplier === 'oreilly' ? await searchOreilly(query, { maxDetails: 8 }) : await searchMusgrave(query);

console.log(`${supplier} "${query}" → ${hits.length} cards\n`);
for (const hit of hits) {
  const exVat = toExVat(hit.quote.rawCasePrice, hit.quote.vatRate, hit.quote.priceIsVatInclusive);
  const c = candidateFromCard(supplier, hit.card, Number.isFinite(exVat) ? exVat : undefined);
  console.log(
    `  ${(c.name ?? '').slice(0, 52).padEnd(54)} sku=${(c.sku ?? '—').padEnd(10)} ` +
      `€${(c.exVatCasePrice ?? 0).toFixed(2).padStart(8)}  upc=${c.unitsPerCase ?? '—'} ` +
      `size=${c.unitSize ?? '—'}${c.uom ?? ''} mp=${c.multipack ?? '—'}`,
  );
  console.log(`      identity="${commercialIdentity(c)}"`);
}
