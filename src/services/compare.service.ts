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

/**
 * Human-readable pack for a product card: "16 x 38 g".
 *
 * The supplier's OWN text wins, and the parsed `caseConfig` is only the
 * fallback. That is the opposite of what the matching pipeline does, on
 * purpose — this string is read by a person, not compared by a rule.
 *
 * `parseSizeText` takes the first `N x M` it finds, which is right for the
 * common shapes and wrong for a nested pack: Musgrave's real
 * "6 x (3 x 450 g)" parses to 3 × 450g, quietly dropping the outer 6 and
 * understating the case by a factor of six. Reformatting a string that was
 * already correct is how that lands on screen, so it is not reformatted.
 *
 * The parsed form still covers suppliers that expose the pack as separate
 * numeric fields and no combined text at all (Barry Group's list rows), where
 * there is nothing verbatim to show. `parseSizeText` returns a 1×1 "each" when
 * it could not read the text — a parse failure wearing a real-looking value —
 * so that sentinel yields nothing rather than claiming the pack is a single.
 */
function packLabel(
  caseConfig: ProductMatch["caseConfig"] | undefined,
  sizeText: string | undefined,
): string | undefined {
  const verbatim = sizeText?.trim();
  if (verbatim) return verbatim;

  const unitsPerCase = caseConfig?.unitsPerCase;
  const unitSize = caseConfig?.unitSize;
  if (unitsPerCase === undefined || unitSize === undefined) return undefined;
  if (unitsPerCase === 1 && unitSize === 1 && caseConfig?.uom === "each") {
    return undefined;
  }

  // "each" is a unit of counting, not a suffix — "1 × 200each" reads as noise.
  const uom = caseConfig?.uom === "each" ? "" : (caseConfig?.uom ?? "");
  return `${unitsPerCase} × ${unitSize}${uom}`;
}

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

  //
  // Presentation fields, collected alongside the allocator's own inputs.
  //
  // `CanonicalProduct` carries identity only — gtin, name, brand, PMP,
  // own-brand — which is right for allocation and useless for a product card.
  // The picture and the pack live on the SearchCard, and `normalizeCard` drops
  // it, so they have to be gathered here or they are gone by the time the row
  // is built.
  //
  // Merged ACROSS suppliers rather than taken from the first hit: the same EAN
  // can come back from Musgrave with an image and from O'Reilly with a pack
  // size, and a buyer wants both. First non-empty value wins, so a supplier
  // that omits a field never blanks one another supplier supplied.
  //
  const display = new Map<string, { imageUrl?: string; packSize?: string }>();

  for (const item of uniqueResults.values()) {
    matches.push(item.match);
    quotes.push(item.quote);

    if (!products.has(item.product.unitGtin)) {
      products.set(item.product.unitGtin, item.product);
    }

    const current = display.get(item.product.unitGtin) ?? {};

    if (!current.imageUrl && item.card.imageUrl) {
      current.imageUrl = item.card.imageUrl;
    }

    if (!current.packSize) {
      const pack = packLabel(item.match.caseConfig, item.card.sizeText);
      if (pack) current.packSize = pack;
    }

    display.set(item.product.unitGtin, current);
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
        // The barcode under its own name. `unitGtin` has carried it all along —
        // both suppliers set it from `card.eanText` — but a field called
        // "unitGtin" reads as an internal key, so the UI was falling back to
        // printing it where the pack size should have been. Named explicitly,
        // it can be labelled "EAN" on screen and the pack can have its own slot.
        ean: product?.unitGtin ?? "",
        ...(display.get(line.unitGtin)?.packSize
          ? { packSize: display.get(line.unitGtin)!.packSize }
          : {}),
        ...(display.get(line.unitGtin)?.imageUrl
          ? { imageUrl: display.get(line.unitGtin)!.imageUrl }
          : {}),
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
