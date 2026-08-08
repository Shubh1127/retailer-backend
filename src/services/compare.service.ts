import { searchAllSuppliers, SUPPLIERS } from "./supplierSearch.js";

import { allocate } from "../allocation/engine.js";
import { prepareLine } from "../allocation/offers.js";

import type { AllocationLineInput } from "../allocation/offers.js";

import type {
  AllocationConfig,
  CanonicalProduct,
  OrderRequestLine,
  PriceQuote,
  ProductMatch,
} from "../types.js";

export async function compareProducts(query: string, config: AllocationConfig) {
  //
  // Search all suppliers concurrently. A supplier that fails is reported rather
  // than aborting the comparison, so one broken login still yields a result.
  //
  const { hits, errors } = await searchAllSuppliers(query);

  //
  // Merge all normalized connector output.
  //
  const results = [...hits.values()].flat();
  const uniqueResults = new Map<string, (typeof results)[number]>();

  for (const item of results) {
    if (!item.product.unitGtin) {
      continue;
    }

    const key = `${item.match.supplierId}:${item.product.unitGtin}`;

    if (!uniqueResults.has(key)) {
      uniqueResults.set(key, item);
    }
  }

  //   console.log(results.length);

  // for (const item of results) {
  //   if (!item.product) {
  //     console.dir(item, { depth: null });
  //     break;
  //   }
  // }

  //
  // Build lookup collections expected by offers.ts
  //
  const matches: ProductMatch[] = [];
  const quotes: PriceQuote[] = [];
  const products = new Map<string, CanonicalProduct>();

  for (const item of uniqueResults.values()) {
    matches.push(item.match);
    quotes.push(item.quote);

    if (!products.has(item.product.unitGtin)) {
      products.set(item.product.unitGtin, item.product);
    }
  }

  //   const grouped = new Map<string, Set<string>>();

  //   for (const match of matches) {
  //     if (!grouped.has(match.unitGtin)) {
  //       grouped.set(match.unitGtin, new Set());
  //     }

  //     grouped.get(match.unitGtin)!.add(match.supplierId);
  //   }

  //   let comparable = 0;

  //   for (const suppliers of grouped.values()) {
  //     if (suppliers.size > 1) {
  //       comparable++;
  //     }
  //   }

  // console.log("Comparable EANs:", comparable);

  //
  // Supplier configuration — shared with batch order preparation.
  //
  const suppliers = SUPPLIERS;

  //
  // Build allocator input.
  //
  const prepared: AllocationLineInput[] = [];

  for (const product of products.values()) {
    const line: OrderRequestLine = {
      unitGtin: product.unitGtin,
      cases: 1,
    };

    prepared.push(
      prepareLine(line, {
        matches,
        quotes,
        suppliers,
        products,
        config,
      }),
    );
  }

  const allocation = allocate(prepared, Array.from(suppliers.values()), config);

  const rows = prepared.map((line) => {
    const product = products.get(line.unitGtin);

    const allocationLine = allocation.lines.find(
      (l) => l.unitGtin === line.unitGtin,
    );

    return {
      unitGtin: line.unitGtin,

      product: {
        name: product?.name ?? "",
        brand: product?.brand ?? "",
        unitGtin: product?.unitGtin ?? "",
      },

      suppliers: {
        musgrave: line.offers.find((o) => o.supplierId === "musgrave") ?? null,

        oreilly: line.offers.find((o) => o.supplierId === "oreilly") ?? null,
      },

      allocation: allocationLine,
    };
  });

  return {
    query,
    rows,
    /** Suppliers that could not be searched (login/network); empty on success. */
    supplierErrors: errors,
  };
}
