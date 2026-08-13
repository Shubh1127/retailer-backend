/**
 * Cross-supplier barcode matching — the shared step, used by BOTH matchers.
 *
 * Shared on purpose. The dashboard (`dashboardPipeline.service.ts`) and the
 * purchase-order CSV (`orderFile.service.ts`) are two separate matchers that
 * already disagree in places, and a barcode confirmation appearing in one but
 * not the other would mean the screen and the order it produces could name
 * different products for the same line. So the logic lives here and both call
 * it; neither owns a copy.
 *
 * WHAT IT DOES
 *
 * Text retrieval has already run and produced candidates from both suppliers.
 * This takes the barcodes off the strongest few, looks each one up in the OTHER
 * supplier's local catalogue, and folds anything it finds back into the same
 * candidate list — marking both sides `eanExact` when a barcode is confirmed on
 * both.
 *
 * WHY THE TOP FEW AND NOT THE TOP ONE
 *
 * The top text result is not reliably right. Keying off it alone means a wrong
 * first result sends a confident exact lookup to the wrong product at the other
 * supplier — and the result then carries MORE authority than the mistake it
 * came from, because it looks independently verified. Taking the best two or
 * three costs two extra indexed reads and makes a single bad rank recoverable:
 * the wrong candidate's barcode simply finds nothing, or finds a product the
 * rules then reject on pack and variant.
 *
 * WHY IT IS SAFE TO RUN ON EVERY LINE
 *
 * Both lookups are local indexed reads against Supabase — no supplier requests,
 * no rate limit, no bot protection. See `eanLookup.service.ts`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * Reject anything. A barcode that differs between two candidates is not
 * evidence they are different products — a supplier may list the outer case
 * code, a private-label code, or a re-issued one. Differences are left for
 * reconciliation and commercial equivalence to weigh; this stage only ever
 * ADDS candidates and marks confirmations.
 */

import { canonicalGtin, findAllByGtins, type EanHit } from './eanLookup.service.js';
import type { RuleCandidate } from './ruleEngine.js';
import { createLogger } from '../log.js';

const log = createLogger('ean-cross-match');

/**
 * How many candidates per supplier contribute their barcode.
 *
 * Three. One is a single point of failure; beyond three the extra candidates
 * are ones the text ranking already considers poor, and their barcodes pull in
 * products with no relation to the line.
 */
export const DEFAULT_TOP_N = 3;

export type SupplierId = 'musgrave' | 'oreilly';

const SUPPLIERS: SupplierId[] = ['musgrave', 'oreilly'];

export interface CrossMatchOptions {
  /** Candidates per supplier whose barcode is used. Defaults to 3. */
  topN?: number;
  /**
   * Injected in tests so this runs without a database. Production leaves it
   * unset and the local catalogue lookups are used.
   */
  lookup?: (supplier: SupplierId, gtins: readonly string[]) => Promise<EanHit[]>;
}

export interface CrossMatchDiagnostics {
  /** Canonical barcodes taken from the text candidates, per supplier. */
  probed: { supplier: SupplierId; gtins: string[] }[];
  /** Candidates the barcode lookups added that text retrieval had missed. */
  added: number;
  /** Barcodes present at both suppliers after the lookups. */
  confirmed: string[];
  /**
   * Supplier codes the barcode lookups found that text retrieval had not.
   *
   * These candidates carry NO price — the catalogue row's is as old as the last
   * sync, and a stale figure must never reach `chooseBestSupplier`. The caller
   * feeds each SKU back through live supplier search to price it, exactly as it
   * already does for an admin-confirmed SKU and a persisted identity SKU.
   *
   * A discovery that cannot be re-priced still counts for identity — it is what
   * confirms the barcode at both suppliers — it simply cannot win the line.
   */
  discovered: { supplier: SupplierId; sku: string }[];
}

export interface CrossMatchResult {
  /**
   * The original candidates plus anything the barcode lookups found, with
   * `eanExact` set on every candidate whose barcode is confirmed at both
   * suppliers. Input candidates are never removed or reordered.
   */
  candidates: RuleCandidate[];
  diagnostics: CrossMatchDiagnostics;
}

function keyOf(candidate: RuleCandidate): string {
  return `${candidate.supplier}:${candidate.sku ?? candidate.name}`;
}

/**
 * Which of these barcodes are stocked by more than one supplier.
 *
 * THE SHARED DECISION. Both matchers answer "is this identity confirmed
 * independently?" by calling this, so the dashboard and the purchase-order CSV
 * cannot reach opposite conclusions about the same product — which is the
 * failure mode of having two matchers at all.
 *
 * `seenBySupplier` is what TEXT search already found. Anything absent from it
 * is looked up in the other supplier's local catalogue, so a product only one
 * supplier's search returned can still be confirmed: the other stocks it, the
 * text query simply did not surface it. That is the whole point — text
 * retrieval missing a product is common, and the barcode does not care.
 *
 * Local indexed reads only. Never throws: a lookup that cannot run confirms
 * nothing, and both callers still have their own text-based answer.
 */
export async function confirmAcrossSuppliers(
  seenBySupplier: ReadonlyMap<SupplierId, ReadonlySet<string>>,
  options: CrossMatchOptions = {},
): Promise<{ confirmed: Set<string>; hits: EanHit[] }> {
  const lookup = options.lookup ?? findAllByGtins;

  const known = new Map<SupplierId, Set<string>>(
    SUPPLIERS.map((supplier) => [supplier, new Set(seenBySupplier.get(supplier) ?? [])]),
  );

  // Each supplier is asked about the barcodes the OTHERS reported. Asking about
  // its own would only re-find what it already returned.
  const probes = new Map<SupplierId, string[]>();
  for (const supplier of SUPPLIERS) {
    const wanted = new Set<string>();
    for (const other of SUPPLIERS) {
      if (other === supplier) continue;
      for (const gtin of known.get(other)!) {
        if (!known.get(supplier)!.has(gtin)) wanted.add(gtin);
      }
    }
    probes.set(supplier, [...wanted]);
  }

  const results = await Promise.all(
    SUPPLIERS.map(async (supplier) => {
      const gtins = probes.get(supplier)!;
      if (gtins.length === 0) return [] as EanHit[];
      try {
        return await lookup(supplier, gtins);
      } catch (error) {
        log.warn('Cross-supplier barcode lookup failed', {
          supplier,
          message: error instanceof Error ? error.message : String(error),
        });
        return [] as EanHit[];
      }
    }),
  );

  const hits = results.flat();
  for (const hit of hits) known.get(hit.supplier)!.add(hit.gtin14);

  const confirmed = new Set<string>();
  for (const gtin of known.get('musgrave')!) {
    if (known.get('oreilly')!.has(gtin)) confirmed.add(gtin);
  }

  return { confirmed, hits };
}

/**
 * Fold exact-barcode matches into a candidate list.
 *
 * `candidates` must already be in the caller's own best-first order — this
 * module has no opinion on ranking and does not reorder. The dashboard passes
 * SBERT-ranked candidates; the order-file matcher passes its own.
 */
export async function crossMatchByEan(
  candidates: readonly RuleCandidate[],
  options: CrossMatchOptions = {},
): Promise<CrossMatchResult> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const lookup = options.lookup;

  const merged = new Map<string, RuleCandidate>();
  for (const candidate of candidates) merged.set(keyOf(candidate), { ...candidate });

  // ---- Which barcodes to probe, and where -----------------------------------
  //
  // A barcode found on Musgrave is looked up at O'Reilly and vice versa —
  // neither supplier is the anchor. Whoever happens to have published a usable
  // barcode for this line drives the lookup at the other.
  const probes = new Map<SupplierId, Set<string>>(SUPPLIERS.map((s) => [s, new Set<string>()]));
  const seenGtins = new Map<SupplierId, Set<string>>(
    SUPPLIERS.map((s) => [s, new Set<string>()]),
  );

  for (const supplier of SUPPLIERS) {
    const fromThisSupplier = candidates.filter((entry) => entry.supplier === supplier);

    for (const candidate of fromThisSupplier.slice(0, topN)) {
      const gtin = canonicalGtin(candidate.ean);
      if (!gtin) continue;

      seenGtins.get(supplier)!.add(gtin);
      for (const other of SUPPLIERS) {
        if (other !== supplier) probes.get(other)!.add(gtin);
      }
    }

    // Barcodes beyond the top N are deliberately NOT added.
    //
    // `confirmAcrossSuppliers` derives its probe list from this set, so adding
    // them here would quietly defeat the cap and send a lookup for every
    // barcode on the page — including ones the ranking already judged poor.
    //
    // Nothing is lost by leaving them out. If the product really is stocked at
    // the other supplier, its own top-N barcode probes back in this direction
    // and the catalogue lookup finds it whatever it ranked here.
  }

  // ---- Look them up ---------------------------------------------------------
  //
  // Delegated to the shared decision so the order-file matcher, which cannot
  // use the candidate-merging half of this function, still reaches the same
  // verdict about which identities are confirmed.
  //
  // `probes` is not passed: `confirmAcrossSuppliers` derives the same thing
  // from what each supplier was seen to have. The top-N restriction is already
  // applied above, in what went into `seenGtins`.
  const { confirmed, hits } = await confirmAcrossSuppliers(seenGtins, { lookup });

  let added = 0;
  const discovered: { supplier: SupplierId; sku: string }[] = [];

  for (const hit of hits) {
    const key = keyOf(hit.candidate);
    if (merged.has(key)) {
      // Text retrieval already found this product. Keep its richer record —
      // the live search carries fields the catalogue row does not, including a
      // current price — and let it be marked confirmed below.
      continue;
    }

    merged.set(key, { ...hit.candidate });
    added++;

    // Reported so the caller can re-price it. Without a SKU there is nothing to
    // search for, so it stays identity-only.
    if (hit.candidate.sku) {
      discovered.push({ supplier: hit.supplier, sku: hit.candidate.sku });
    }
  }

  if (confirmed.size > 0) {
    for (const candidate of merged.values()) {
      const gtin = canonicalGtin(candidate.ean);
      if (gtin && confirmed.has(gtin)) candidate.eanExact = true;
    }
  }

  return {
    candidates: [...merged.values()],
    diagnostics: {
      probed: SUPPLIERS.map((supplier) => ({
        supplier,
        gtins: [...probes.get(supplier)!],
      })),
      added,
      confirmed: [...confirmed],
      discovered,
    },
  };
}
