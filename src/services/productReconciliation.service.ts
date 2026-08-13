/**
 * Product reconciliation — the final safety gate before allocation and cart.
 *
 *   Excel product → search → SBERT → rule engine → selected → RECONCILIATION → allocation → cart
 *
 * This is not another ranking algorithm and it makes no commercial decision. It
 * asks one question about one already-selected product:
 *
 *   Is this the same commercial product the retailer asked for?
 *
 * If the answer is no, the product must never reach allocation or a supplier
 * cart. Nothing downstream re-checks this.
 *
 * Independent by design
 * ---------------------
 * Reconciliation deliberately takes NOTHING from the rule engine on trust — not
 * its verdict, not its confidence, not its rule outcomes. A gate that re-used
 * the conclusions of the stage it is guarding would pass exactly the cases that
 * stage got wrong, which is the one job it has. It re-derives every comparison
 * from the retailer's Excel line and the supplier's own stated attributes.
 *
 * What IS shared is the primitive comparison vocabulary — `comparePack`,
 * `specificityOf`, `uomFromText`, `containerOf`, `multipackCount`,
 * `caseBaseQuantity`. Those are measurements, not judgements, and having two
 * implementations of "is 24 × 38 the same as 24 × 38" is how the two stages
 * would silently drift apart.
 *
 * Deterministic
 * -------------
 * No GPT, no SBERT, no thresholds, no confidence anywhere in this file. Every
 * output is a function of the two products' structured attributes. The same two
 * products always reconcile the same way.
 *
 * Not to be confused with `src/reconcile.ts`, which diffs a supplier's cart
 * AFTER assisted-fill. This runs before anything is added.
 */

import {
  containerOf,
  identityTokensFor,
  multipackCount,
  specificityOf,
  uomFromText,
  type RuleTarget,
  type SelectedCandidate,
} from './ruleEngine.js';
import { comparePack } from './matchConfidence.js';
import { getMatchingConfig } from '../normalization/matchingConfig.js';
import { caseBaseQuantity } from '../pricing/normalize.js';
import type { Uom } from '../types.js';

/**
 * Machine-readable failure codes. Stable identifiers — the dashboard groups
 * rejections, builds exception files and drives suggestions off these, so they
 * are part of the contract and must not be renamed casually.
 */
export type ReconciliationCode =
  | 'VARIANT_MISMATCH'
  | 'PRODUCT_IDENTITY_MISMATCH'
  | 'BRAND_MISMATCH'
  | 'PACK_MISMATCH'
  | 'UNIT_SIZE_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'MULTIPACK_MISMATCH'
  | 'CONTAINER_MISMATCH'
  | 'PACK_NOT_VERIFIABLE'
  | 'ALCOHOL_MISMATCH'
  | 'EAN_DIFFERENCE'
  | 'MISSING_SKU'
  | 'MISSING_PRICE';

/**
 * `critical` blocks allocation and cart. `warning` is recorded and surfaced but
 * does not block — used where the EPOS export genuinely cannot supply the field,
 * so treating it as a failure would reject the whole file rather than protect it.
 */
export type ReconciliationSeverity = 'critical' | 'warning';

export interface ReconciliationDifference {
  code: ReconciliationCode;
  /** Attribute name, for the dashboard's column. */
  field: string;
  /** What the retailer asked for. `null` when the line stated nothing. */
  requested: string | number | null;
  /** What the selected supplier product actually is. */
  allocated: string | number | null;
  reason: string;
  severity: ReconciliationSeverity;
  /**
   * This difference would have blocked the line, but an admin confirmed the
   * product anyway, so it was recorded as a warning instead.
   *
   * The dashboard needs this to say the useful thing: not "passed with
   * warnings", but "the product an admin chose differs from the order line in
   * these ways". Same facts, and the second one is the one a buyer can act on.
   */
  overriddenByAdmin?: boolean;
  /**
   * This would have blocked the line, but the same barcode was found at both
   * suppliers, so identity is settled by a GS1 number rather than by the name
   * the difference was derived from.
   *
   * Only ever set on identity rules — variant and brand. A pack or container
   * difference is about the OFFER, not the product, and a barcode says nothing
   * about it.
   */
  confirmedByBarcode?: boolean;
}

export interface ReconciliationResult {
  /** No critical difference. */
  passed: boolean;
  /** May this product be handed to the allocation engine? */
  safeToAllocate: boolean;
  /** May this product be put in a supplier cart? Needs an orderable SKU too. */
  safeToAddToCart: boolean;
  differences: ReconciliationDifference[];
  /** Just the codes, for grouping and filtering. */
  codes: ReconciliationCode[];

  // ---- Dashboard fields ----
  /** The retailer's product, as written in the file. */
  product: string;
  /** Excel row this came from, when known. */
  row?: number;
  articleCode?: string;
  supplier: string;
  /** The supplier product that was selected. */
  allocatedProduct: string;
  sku?: string;
  /** One sentence for the dashboard's Reason column. */
  summary: string;
}

/** The retailer's request. `RuleTarget` plus where in the file it came from. */
export interface ReconciliationRequest extends RuleTarget {
  row?: number;
  articleCode?: string;
  // `container` is inherited from RuleTarget — see the note there for why it
  // must be an explicit field rather than re-read from the description.
  /**
   * Barcode the retailer stated, when their export carries one. The EPOS
   * "Article Order Listing" does not, so this is normally absent — see the EAN
   * section for why that is not a problem.
   */
  ean?: string;
}

/** Uppercased for the human-facing variant messages ("WHITE", "DARK"). */
function shout(tokens: readonly string[]): string {
  return tokens.map((t) => t.toUpperCase()).join(' ');
}

function packText(unitsPerCase?: number, unitSize?: number, uom?: Uom): string | null {
  if (unitsPerCase === undefined || unitSize === undefined) return null;
  return `${unitsPerCase} × ${unitSize}${uom ?? ''}`;
}

/** Unit size in its family's base unit, for scale-independent comparison. */
function baseUnitSize(unitSize: number, uom: Uom): { family: string; quantity: number } {
  return caseBaseQuantity({ unitsPerCase: 1, unitSize, uom, isCatchWeight: false });
}

/**
 * Reconcile one selected supplier product against the retailer's Excel line.
 *
 * Pure and deterministic: same two products in, same result out, no clock, no
 * network, no model.
 */
export function reconcileProduct(
  request: ReconciliationRequest,
  allocated: SelectedCandidate,
  /**
   * Brands observed elsewhere for this same line. Needed because suppliers
   * disagree about where the manufacturer lives — Musgrave states it in a brand
   * field, O'Reilly puts it in the product title with no brand field at all.
   * Without pooling, "Nestle Std Smarties Hexatube" reads as an unrequested
   * "Nestle" variant of "SMARTIES HEXATUBE".
   */
  knownBrands: readonly (string | undefined)[] = [],
): ReconciliationResult {
  const differences: ReconciliationDifference[] = [];

  // Normalized identity tokens for both sides. Computed once, up front: the
  // variant rule and the product-identity rule both need them, and deriving
  // them twice is how the two could disagree.
  const requestTokensForVariant = identityTokensFor(
    request.description,
    undefined,
    knownBrands,
  );
  const allocatedTokens = identityTokensFor(
    allocated.name,
    allocated.supplier,
    knownBrands,
  );

  // ---- Variant / commercial identity -------------------------------------
  //
  // The decisive rule. Identity tokens are compared with the brand stripped from
  // both sides, so a manufacturer prefix is never mistaken for a variant. There
  // is no list of variant words here — "White", "Dark" and "Zero" are never
  // named; what is measured is which identity tokens each side carries.
  const specificity = specificityOf(
    request,
    {
      supplier: allocated.supplier,
      name: allocated.name,
      ...(allocated.brand ? { brand: allocated.brand } : {}),
    },
    knownBrands,
  );

  const { missing, extra } = specificity;

  if (missing.length > 0 && extra.length > 0) {
    // Requested one variant, got a different one.
    differences.push({
      code: 'VARIANT_MISMATCH',
      field: 'variant',
      requested: shout(missing),
      allocated: shout(extra),
      reason: `Requested variant ${shout(missing)} but supplier product is ${shout(extra)}`,
      severity: 'critical',
    });
  } else if (missing.length > 0) {
    // Requested a variant, got the base product.
    differences.push({
      code: 'VARIANT_MISMATCH',
      field: 'variant',
      requested: shout(missing),
      allocated: null,
      reason: `Requested variant ${shout(missing)} but allocated product has no variant`,
      severity: 'critical',
    });
  } else if (specificity.extraVariants.length > 0) {
    // An unrequested FORMULATION. Decisive — this is a different version of the
    // product, whatever else agrees.
    differences.push({
      code: 'VARIANT_MISMATCH',
      field: 'variant',
      requested: null,
      allocated: shout(specificity.extraVariants),
      reason: 'Unrequested commercial variant',
      severity: 'critical',
    });
  } else if (extra.length > 0) {
    // Requested the base product, got something with extra words. Those extra
    // words are ambiguous on their own:
    //
    //   Kinder Bueno -> Kinder Bueno White                        a real variant
    //   Nutella & Go -> Nutella & Go Hazelnut ... Bread Sticks    a descriptive tail
    //
    // Structurally identical. What separates them is whether the supplier ALSO
    // listed a plain version: if it did, the retailer asked for that one and
    // this is a different product. If it did not, these are simply the words
    // that supplier uses for the product the retailer asked for.
    // Only PRODUCT DESCRIPTORS remain — the supplier describes the same product
    // more fully ("Nutella & Go Hazelnut & Chocolate Spread with Bread Sticks").
    // That is not an identity contradiction, so it does not block: a descriptor
    // that genuinely distinguishes a different product ("Coca Cola Cherry") is
    // rejected earlier by the rule engine, which can see the plainer sibling.
    //
    // The alternative — deleting descriptor words from a dictionary until the
    // match succeeds — is unfalsifiable and grows without end.
    differences.push({
      code: 'VARIANT_MISMATCH',
      field: 'variant',
      requested: null,
      allocated: shout(specificity.extraDescriptors),
      reason: `Supplier describes this product more fully (${shout(specificity.extraDescriptors)}) — same commercial identity`,
      severity: 'warning',
    });
  }

  // ---- Product identity --------------------------------------------------
  // A selected product that shares NO identity token with the request is not the
  // same product at all — a distinct failure from carrying the wrong variant.
  //
  // Compared on NORMALIZED tokens: a retailer writing "LOZ" and a supplier
  // writing "Lozenges" must not read as two unrelated products.
  const requestTokens = requestTokensForVariant;
  const shared = [...requestTokens].filter((token) => allocatedTokens.has(token));

  if (requestTokens.size > 0 && allocatedTokens.size > 0 && shared.length === 0) {
    differences.push({
      code: 'PRODUCT_IDENTITY_MISMATCH',
      field: 'productName',
      requested: request.description,
      allocated: allocated.name,
      reason: 'Allocated product shares no identifying words with the requested product',
      severity: 'critical',
    });
  }

  // ---- Brand -------------------------------------------------------------
  //
  // WARNING, not critical, and deliberately so: the EPOS export has no brand
  // column, and its descriptions are terse product names ("SMARTIES HEXATUBE")
  // while supplier cards state a manufacturer ("NESTLE"). Treating a non-overlap
  // as a failure would reject nearly every line in a real file. A genuine brand
  // substitution shows up as an identity-token difference above, which IS
  // critical, so nothing unsafe passes because of this.
  if (allocated.brand) {
    const brandTokens = [...identityTokensFor(allocated.brand, allocated.supplier)];
    const named = brandTokens.some((token) => requestTokens.has(token));
    if (brandTokens.length > 0 && !named && requestTokens.size > 0) {
      differences.push({
        code: 'BRAND_MISMATCH',
        field: 'brand',
        requested: null,
        allocated: allocated.brand,
        reason:
          `Retailer line does not name a brand; supplier product is ${allocated.brand}` +
          ' — not verifiable from this export',
        severity: 'warning',
      });
    }
  }

  // ---- Pack --------------------------------------------------------------
  const pack = comparePack(
    {
      ...(request.unitsPerCase !== undefined ? { unitsPerCase: request.unitsPerCase } : {}),
      ...(request.unitSize !== undefined ? { unitSize: request.unitSize } : {}),
    },
    allocated.unitsPerCase !== undefined && allocated.unitSize !== undefined
      ? { unitsPerCase: allocated.unitsPerCase, unitSize: allocated.unitSize }
      : undefined,
  );

  const requestUom = request.uom ?? uomFromText(request.description);
  const allocatedUom = allocated.uom;

  if (!pack.known) {
    // UNKNOWN, not MISMATCH. A supplier that does not publish a pack size has
    // told us nothing — it has not told us the pack is wrong. Failing here
    // rejected products on missing data rather than on contradicting data,
    // which is the opposite of what a safety gate is for. Recorded as a warning
    // so the gap is visible without blocking the line.
    differences.push({
      code: 'PACK_NOT_VERIFIABLE',
      field: 'pack',
      requested: packText(request.unitsPerCase, request.unitSize, requestUom),
      allocated: packText(allocated.unitsPerCase, allocated.unitSize, allocatedUom),
      reason: 'Pack size is not stated on both sides — could not be verified',
      severity: 'warning',
    });
  } else {
    // A pack difference is a quantity question, not a wrong product. Under
    // `packDifference: 'warn'` it is reported and the line still ships to Ready
    // To Order, where the retailer can see both sizes and pick. Identity rules
    // stay critical — a size never turns one product into another.
    const packCritical = getMatchingConfig().packDifference === 'reject';

    if (!pack.unitsPerCaseMatch) {
      differences.push({
        code: 'PACK_MISMATCH',
        field: 'unitsPerCase',
        requested: request.unitsPerCase!,
        allocated: allocated.unitsPerCase!,
        reason:
          `Same product, different pack size — you asked for ` +
          `${packText(request.unitsPerCase, request.unitSize, requestUom)}, ` +
          `supplier sells ${packText(allocated.unitsPerCase, allocated.unitSize, allocatedUom)}`,
        severity: packCritical ? 'critical' : 'warning',
      });
    }

    // Compared in base units so "1.5 L" and "1500 ml" reconcile instead of
    // failing on a scale difference the supplier merely expressed differently.
    let unitSizeAgrees = pack.unitSizeMatch;
    if (!unitSizeAgrees && requestUom && allocatedUom) {
      const left = baseUnitSize(request.unitSize!, requestUom);
      const right = baseUnitSize(allocated.unitSize!, allocatedUom);
      if (left.family === right.family) {
        const tolerance = Math.max(0.5, left.quantity * 0.02);
        unitSizeAgrees = Math.abs(left.quantity - right.quantity) <= tolerance;
      }
    }

    if (!unitSizeAgrees) {
      // Same case configuration, different unit size — a stocking choice, not a
      // wrong product. Within the configured band this warns and the line still
      // passes; beyond it the products are too far apart and it stays critical.
      const drift =
        request.unitSize! > 0
          ? Math.abs(allocated.unitSize! - request.unitSize!) / request.unitSize!
          : Number.POSITIVE_INFINITY;
      const nearMatch =
        pack.unitsPerCaseMatch && drift <= getMatchingConfig().unitSize.nearMatchPct;

      differences.push({
        code: 'UNIT_SIZE_MISMATCH',
        field: 'unitSize',
        requested: request.unitSize!,
        allocated: allocated.unitSize!,
        reason: nearMatch
          ? `Requested ${request.unitSize}${requestUom ?? ''}, available ` +
            `${allocated.unitSize}${allocatedUom ?? ''} — same case of ${allocated.unitsPerCase}`
          : `Unit size mismatch (requested ${request.unitSize}${requestUom ?? ''}, ` +
            `allocated ${allocated.unitSize}${allocatedUom ?? ''})`,
        severity: nearMatch || !packCritical ? 'warning' : 'critical',
      });
    }
  }

  // ---- Unit of measure ---------------------------------------------------
  // Compared by family: g↔kg is one quantity at two scales, g↔ml is not.
  // Unknown on the retailer side is normal — the export states no unit at all.
  if (requestUom && allocatedUom) {
    const left = baseUnitSize(1, requestUom);
    const right = baseUnitSize(1, allocatedUom);
    if (left.family !== right.family) {
      differences.push({
        code: 'UNIT_MISMATCH',
        field: 'uom',
        requested: requestUom,
        allocated: allocatedUom,
        reason: `Unit of measure mismatch (requested ${requestUom}, allocated ${allocatedUom})`,
        severity: 'critical',
      });
    }
  }

  // ---- Multipack ---------------------------------------------------------
  // Unstated means single: a line that did not ask for a 4-pack wants the single.
  // Explicit field first — normalization removes "10 PACK" from the
  // description, so re-reading it finds nothing and every multipack would
  // silently compare as a single.
  // The "is this just restating the case?" guard must be SYMMETRIC — each side
  // applying it against its OWN case size produced a false "10 vs 1" on two
  // listings of the same 10-pack. Same fix as the rule engine.
  const cases = [request.unitsPerCase, allocated.unitsPerCase].filter(
    (value): value is number => value !== undefined,
  );
  const dropIfRestatesCase = (count: number | undefined) =>
    count !== undefined && cases.includes(count) ? undefined : count;

  const requestedMultipack =
    dropIfRestatesCase(
      request.multipack ?? multipackCount(request.description, request.unitsPerCase),
    ) ?? 1;
  const allocatedMultipack =
    dropIfRestatesCase(
      allocated.multipack ?? multipackCount(allocated.name, allocated.unitsPerCase),
    ) ?? 1;

  if (requestedMultipack !== allocatedMultipack) {
    differences.push({
      code: 'MULTIPACK_MISMATCH',
      field: 'multipack',
      requested: requestedMultipack,
      allocated: allocatedMultipack,
      reason: `Multipack mismatch (requested ${requestedMultipack}, allocated ${allocatedMultipack})`,
      severity: 'critical',
    });
  }

  // ---- Container ---------------------------------------------------------
  // Only comparable when both sides state one; a bottle is never a can.
  // Explicit field first — `request.description` is normalized text with the
  // container already removed, so re-reading it finds nothing and containers
  // would silently stop being compared at all.
  const requestedContainer = request.container ?? containerOf(request.description);
  const allocatedContainer = allocated.container ?? containerOf(allocated.name);

  if (requestedContainer && allocatedContainer && requestedContainer !== allocatedContainer) {
    differences.push({
      code: 'CONTAINER_MISMATCH',
      field: 'container',
      requested: requestedContainer,
      allocated: allocatedContainer,
      reason: `Container mismatch (requested ${requestedContainer}, allocated ${allocatedContainer})`,
      severity: 'critical',
    });
  }

  // ---- Alcohol by volume --------------------------------------------------
  //
  // An alcohol-free order must never be filled with the full-strength product.
  // Asymmetric by design: when the line asks for 0.0%, a candidate that does not
  // also state 0.0% is blocked, because alcohol-free is always marked and its
  // absence means full strength.
  if (request.abv === 0 && allocated.abv !== 0) {
    differences.push({
      code: 'ALCOHOL_MISMATCH',
      field: 'abv',
      requested: '0.0%',
      allocated: allocated.abv !== undefined ? `${allocated.abv}%` : null,
      reason:
        'Order line is alcohol-free (0.0%) but this product does not state 0.0% — likely the full-strength version',
      severity: 'critical',
    });
  }

  // ---- EAN ---------------------------------------------------------------
  //
  // VERIFICATION ONLY, never a rejection. A supplier can list the same
  // commercial product under its own barcode — a multipack GTIN, a re-issued
  // code, a private-label EAN — and the retailer's line carries no barcode at
  // all. Rejecting on a differing EAN would fail products that every structured
  // attribute says are identical. Recorded as information, and only when the
  // retailer actually stated one to compare against.
  if (request.ean && allocated.ean && request.ean !== allocated.ean) {
    differences.push({
      code: 'EAN_DIFFERENCE',
      field: 'ean',
      requested: request.ean,
      allocated: allocated.ean,
      reason: `Supplier lists a different barcode (${allocated.ean}) — commercial identity still matches`,
      severity: 'warning',
    });
  }

  // ---- Orderability ------------------------------------------------------
  // Not about product identity, but a line with no code or no price cannot be
  // put in a cart. Blocks the cart specifically, not the identity verdict.
  if (!allocated.sku) {
    differences.push({
      code: 'MISSING_SKU',
      field: 'sku',
      requested: null,
      allocated: null,
      reason: 'Supplier product has no product code — cannot be added to a cart',
      severity: 'critical',
    });
  }

  if (
    allocated.exVatCasePrice === undefined ||
    !Number.isFinite(allocated.exVatCasePrice) ||
    allocated.exVatCasePrice <= 0
  ) {
    differences.push({
      code: 'MISSING_PRICE',
      field: 'price',
      requested: null,
      allocated: allocated.exVatCasePrice ?? null,
      reason: 'Supplier product has no usable price — cannot be allocated or ordered',
      severity: 'critical',
    });
  }

  // ---- Admin override ----------------------------------------------------
  //
  // A human confirmed this exact product for this description. Every rule above
  // asks "is this the requested product", which is the question they already
  // answered — so their answer stands and the identity differences become
  // warnings. They are NOT discarded: an admin who picked a 12-pack against a
  // 24-pack line needs the dashboard to say so, and so does the buyer reading
  // it next week.
  //
  // MISSING_SKU and MISSING_PRICE are deliberately still critical. They are not
  // judgements about identity — they say the line cannot be placed at all, and
  // no amount of human confirmation conjures a price out of a supplier listing.
  const UNORDERABLE: ReconciliationCode[] = ['MISSING_SKU', 'MISSING_PRICE'];

  // The `field` values are attribute names for the dashboard's column, not
  // English. An admin reading "differs on unitsPerCase" has to translate before
  // they can act, so the summary does the translating.
  const FIELD_LABELS: Record<string, string> = {
    variant: 'variant',
    productName: 'product',
    brand: 'brand',
    pack: 'pack size',
    unitsPerCase: 'units per case',
    unitSize: 'unit size',
    uom: 'unit of measure',
    multipack: 'multipack count',
    container: 'container',
    abv: 'alcohol strength',
    ean: 'barcode',
  };

  if (allocated.adminConfirmed) {
    for (const difference of differences) {
      if (difference.severity !== 'critical') continue;
      if (UNORDERABLE.includes(difference.code)) continue;
      difference.severity = 'warning';
      difference.overriddenByAdmin = true;
    }
  }

  // A barcode confirmed at BOTH suppliers settles IDENTITY, and only identity.
  //
  // The variant and brand rules exist because names are the only evidence of
  // identity we normally have — they are a proxy. When two independent
  // catalogues publish the same GS1 number, the proxy is answering a question
  // that has already been answered better, and it should not be able to
  // overrule it.
  //
  // The case that forced this: an EPOS line reading "BOOST ENERGY RED BRRY CAN"
  // against a supplier's "Boost Energy Red Berry Drink Can", both carrying
  // 5000382125464. The retailer mistyped BERRY. `VARIANT_MISMATCH` then read
  // "requested BRRY, got BERRY DR" and blocked a line whose barcode was
  // identical at both suppliers — a typo defeating a GS1 number.
  //
  // DELIBERATELY NARROW. Only the identity rules are downgraded. Pack, unit
  // size, container, multipack and alcohol stay critical, because one barcode
  // genuinely can cover different case levels — this catalogue has a "Display
  // Hod" and a "Box 4 x 5 Pack" under one number — and those are questions
  // about the OFFER, which the barcode says nothing about. That is the
  // distinction between EAN identity and commercial pack equivalence, and it
  // survives here intact.
  //
  // Differences are recorded, never discarded: same code, same reason, same
  // place in `results`. Only the severity changes, so the dashboard still shows
  // what differed.
  const IDENTITY_ONLY: ReconciliationCode[] = ['VARIANT_MISMATCH', 'BRAND_MISMATCH'];

  if (allocated.eanExact) {
    for (const difference of differences) {
      if (difference.severity !== 'critical') continue;
      if (!IDENTITY_ONLY.includes(difference.code)) continue;
      difference.severity = 'warning';
      difference.confirmedByBarcode = true;
    }
  }

  const critical = differences.filter((d) => d.severity === 'critical');
  const passed = critical.length === 0;
  const overridden = differences.filter((d) => d.overriddenByAdmin);

  return {
    passed,
    safeToAllocate: passed,
    safeToAddToCart: passed,
    differences,
    codes: differences.map((d) => d.code),
    product: request.description,
    ...(request.row !== undefined ? { row: request.row } : {}),
    ...(request.articleCode ? { articleCode: request.articleCode } : {}),
    supplier: allocated.supplier,
    allocatedProduct: allocated.name,
    ...(allocated.sku ? { sku: allocated.sku } : {}),
    summary: !passed
      ? critical[0]!.reason
      : overridden.length > 0
        ? `Admin-confirmed product — differs from the order line on ${[
            ...new Set(overridden.map((d) => FIELD_LABELS[d.field] ?? d.field)),
          ].join(', ')}.`
        : allocated.adminConfirmed
          ? 'Admin-confirmed product — matches the order line.'
          : 'Reconciled — same commercial product, pack and variant.',
  };
}

// ---- The gate --------------------------------------------------------------

export interface ReconciledSelection {
  /** Products cleared to continue. THIS is what allocation receives. */
  safe: SelectedCandidate[];
  /** Products stopped here, with why. Never reach allocation or the cart. */
  blocked: ReconciliationResult[];
  /** Every reconciliation performed, passed and failed, for the audit trail. */
  results: ReconciliationResult[];
}

/**
 * Reconcile every product the rule engine selected and let only the clean ones
 * through.
 *
 * The gate is applied per selected product rather than per line, because one
 * supplier's listing can be wrong while the other's is right — blocking the
 * whole line would throw away a good price for a bad match elsewhere.
 */
export function reconcileSelection(
  request: ReconciliationRequest,
  selected: readonly SelectedCandidate[],
): ReconciledSelection {
  // Pool every brand stated across the line's selections before judging any of
  // them, so a supplier that omits the brand field is not penalised for it.
  const knownBrands = [...new Set(selected.map((candidate) => candidate.brand).filter(Boolean))];

  const results = selected.map((candidate) =>
    reconcileProduct(request, candidate, knownBrands),
  );

  const safe: SelectedCandidate[] = [];
  const blocked: ReconciliationResult[] = [];

  for (const [index, result] of results.entries()) {
    if (result.safeToAllocate) safe.push(selected[index]!);
    else blocked.push(result);
  }

  return { safe, blocked, results };
}

// ---- Dashboard -------------------------------------------------------------

export interface ReconciliationDashboardRow {
  row?: number;
  product: string;
  supplier: string;
  allocatedProduct: string;
  /** '✅' | '❌' — ready to render. */
  status: string;
  reason: string;
  codes: ReconciliationCode[];
}

/** Flatten a reconciliation into the row the dashboard renders. */
export function toDashboardRow(result: ReconciliationResult): ReconciliationDashboardRow {
  return {
    ...(result.row !== undefined ? { row: result.row } : {}),
    product: result.product,
    supplier: result.supplier,
    allocatedProduct: result.allocatedProduct,
    status: result.passed ? '✅' : '❌',
    reason: result.summary,
    codes: result.codes,
  };
}

/** Count failures by code — drives the dashboard's rejection report. */
export function summarizeByCode(
  results: readonly ReconciliationResult[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    for (const difference of result.differences) {
      if (difference.severity !== 'critical') continue;
      counts[difference.code] = (counts[difference.code] ?? 0) + 1;
    }
  }
  return counts;
}
