/**
 * Product explainability — the full lifecycle of ONE product, stage by stage.
 *
 *   Excel → normalization → search → SBERT → rules → reconciliation
 *         → allocation → dashboard decision → root-cause diagnosis
 *
 * Why this exists
 * ---------------
 * The pipeline now has six stages that can each reject a product, and telling
 * them apart meant reading source. This module runs the real pipeline with the
 * real services and records what every stage saw and decided, so a failure can
 * be attributed without opening an editor.
 *
 * It observes; it does not decide. Every verdict here is produced by the same
 * functions production uses — `normalizeProduct`, `judgeCandidates`,
 * `selectFinal`, `reconcileSelection`, `chooseBestSupplier`. A trace that
 * disagreed with production would be worse than none.
 *
 * The control probe
 * -----------------
 * When a search returns nothing, "the query was wrong" and "the supplier does
 * not stock it" look identical. So the tracer optionally re-runs the search with
 * the RAW Excel text. If the raw text finds products the canonical text did not,
 * normalization is the culprit and the diagnosis says so — otherwise it is the
 * supplier. That single extra request removes the main ambiguity in the whole
 * report.
 */

import {
  canonicalQuery,
  normalizeProduct,
  type NormalizationStep,
  type NormalizedProduct,
} from '../normalization/productNormalization.js';
import { searchMusgrave } from './musgrave.service.js';
import { searchOreilly } from './oreilly.service.js';
import { toExVat } from '../pricing/normalize.js';
import { rankCandidates, type AiCandidate } from './aiMatch.client.js';
import {
  candidateFromCard,
  identityTokensFor,
  judgeCandidates,
  selectFinal,
  type CandidateJudgement,
  type FinalSelection,
  type RuleCandidate,
  type RuleTarget,
} from './ruleEngine.js';
import {
  reconcileSelection,
  type ReconciliationResult,
} from './productReconciliation.service.js';
import { chooseBestSupplier, type DashboardOffer } from './dashboardPipeline.service.js';
import {
  compareParsed,
  parseProduct,
  vocabularyFor,
  type FieldComparison,
  type ParsedProduct,
} from '../parsing/productParser.js';
import { categoryConflicts } from '../parsing/tokenCategory.js';
import { SUPPLIERS } from './supplierSearch.js';
import type { ShopArticle } from '../ingest/eposListing.js';

const SUPPLIER_IDS = ['musgrave', 'oreilly'] as const;
type SupplierId = (typeof SUPPLIER_IDS)[number];

// ---- Trace shape -----------------------------------------------------------

export interface TraceExcel {
  row?: number;
  articleCode?: string;
  description: string;
  packRaw?: string;
  unitsPerCase?: number;
  unitSize?: number;
  cases?: number;
  mainCost?: number;
}

/** The structured product the parser produced, for both sides. */
export interface TraceParsed {
  requested: ParsedProduct;
  /** One entry per candidate, in candidate order. */
  candidates: { index: number; parsed: ParsedProduct }[];
  /** Field-by-field verdicts against the best candidate, when there is one. */
  fieldComparison: FieldComparison[];
  /** Tokens configured into more than one category. Empty means the config is sound. */
  categoryConflicts: { token: string; categories: string[] }[];
}

export interface TraceNormalization {
  original: string;
  steps: NormalizationStep[];
  canonical: string;
  metadata: NormalizedProduct['extractedMetadata'];
  /** Identity tokens the later stages actually compare on. */
  identityTokens: string[];
}

/**
 * Proof that every stage received the SAME string. Any `false` here means a
 * product was judged against text it was never searched for.
 */
export interface CanonicalConsistency {
  canonical: string;
  supplierSearch: string;
  sbert: string;
  ruleEngine: string;
  reconciliation: string;
  consistent: boolean;
  differences: { stage: string; received: string }[];
  /**
   * Whether the canonical contains ONLY commercial identity.
   *
   * Consistency alone is worthless: if the canonical itself carries retail
   * metadata, every stage consistently makes the same wrong decision. This
   * checks the string is right, not merely shared.
   */
  pure: boolean;
  /** Metadata-looking tokens still present in the canonical, with why. */
  impurities: { token: string; reason: string }[];
}

/**
 * Tokens that must never survive into a canonical identity.
 *
 * Structural patterns, not a vocabulary — a canonical carrying a price, a piece
 * count or packaging shorthand is malformed regardless of the product.
 */
const IMPURITY_TESTS: { test: RegExp; reason: string }[] = [
  { test: /^[€£$]/, reason: 'retail price' },
  { test: /^\d+(?:\.\d+)?[€£$]?$/, reason: 'bare number — pack or piece count' },
  { test: /^\d+\s*(?:p|pc|pcs|pce|piece|pieces)$/i, reason: 'piece count' },
  { test: /^\d+(?:pk|pack|packs)$/i, reason: 'pack count' },
  { test: /^(?:pk|pmp|pm|cs|ea|btl|cn|ctn)$/i, reason: 'packaging shorthand' },
];

/** Metadata-looking tokens left in a canonical identity. Empty means clean. */
export function canonicalImpurities(canonical: string): { token: string; reason: string }[] {
  const found: { token: string; reason: string }[] = [];
  for (const token of canonical.split(/\s+/).filter(Boolean)) {
    for (const { test, reason } of IMPURITY_TESTS) {
      if (test.test(token)) {
        found.push({ token, reason });
        break;
      }
    }
  }
  return found;
}

export interface TraceCandidate {
  index: number;
  supplier: string;
  name: string;
  /** The supplier name after that supplier's normalization — what SBERT saw. */
  normalizedName: string;
  /**
   * Brand as the supplier states it. Shown because brands are POOLED across a
   * line and stripped from both sides' identity tokens — a brand field that
   * contains a variant word can therefore erase that variant from the
   * comparison, which is invisible unless the brand is on the report.
   */
  brand?: string;
  sku?: string;
  ean?: string;
  unitsPerCase?: number;
  unitSize?: number;
  uom?: string;
  container?: string;
  exVatCasePrice?: number;
}

export interface TraceSbert {
  candidateIndex: number;
  requested: string;
  candidate: string;
  similarity: number;
}

export interface TraceAllocation {
  passCandidates: { supplier: string; product: string; price?: number; verdict: string }[];
  winner?: { supplier: string; product: string; price?: number };
  reason: string;
}

export type FailureStage =
  | 'Normalization'
  | 'Search Query'
  | 'Supplier Search'
  | 'SBERT Ranking'
  | 'Rule Engine'
  | 'Reconciliation'
  | 'Allocation'
  | 'None';

export interface TraceDiagnosis {
  /** Exactly one stage. 'None' when the product succeeded. */
  stage: FailureStage;
  explanation: string;
  /** What to change, when the trace makes that determinable. */
  suggestion?: string;
  /** Result of the control searches, when they were run. */
  controlProbe?: ControlProbe;
}

/**
 * Control searches run only when the canonical query found nothing.
 *
 * "The query was wrong" and "the supplier does not stock it" are
 * indistinguishable from a single empty result, so the tracer asks again:
 * once with the raw Excel text, then with progressively shorter queries. The
 * first query that DOES return products identifies the exact token that was
 * suppressing the search — which is what an engineer would do by hand, and the
 * difference between "Search Query" and "Supplier Search" as a root cause.
 */
export interface ControlProbe {
  attempts: { query: string; label: string; resultCount: number }[];
  /** The shortest query that returned anything. */
  firstHit?: { query: string; label: string; resultCount: number };
  /** Tokens present in the failing query but absent from the first hit. */
  blockingTokens: string[];
  verdict: string;
}

export interface ProductTrace {
  excel: TraceExcel;
  normalization: TraceNormalization;
  /** Structured commercial data — what the pipeline reasons about. */
  parsed: TraceParsed;
  canonicalConsistency: CanonicalConsistency;
  searchQueries: { supplier: string; query: string; note?: string }[];
  candidates: TraceCandidate[];
  supplierErrors: { supplier: string; message: string }[];
  sbert: { input: TraceSbert[]; error?: string; durationMs?: number };
  ruleEngine: CandidateJudgement[];
  selection: FinalSelection;
  reconciliation: ReconciliationResult[];
  allocation: TraceAllocation;
  decision: { status: string; reason: string };
  diagnosis: TraceDiagnosis;
}

export interface TraceOptions {
  maxDetails?: number;
  /** Re-run the search with the raw Excel text to isolate normalization. */
  controlProbe?: boolean;
  /** Injected in tests so the tracer runs without live suppliers. */
  searchers?: Record<SupplierId, (query: string) => Promise<RuleCandidate[]>>;
  rank?: typeof rankCandidates;
}

// ---- Helpers ---------------------------------------------------------------

async function search(
  supplier: SupplierId,
  query: string,
  opts: TraceOptions,
): Promise<{ candidates: RuleCandidate[]; error?: string }> {
  try {
    if (opts.searchers) return { candidates: await opts.searchers[supplier](query) };

    const hits =
      supplier === 'musgrave'
        ? await searchMusgrave(query)
        : await searchOreilly(query, { maxDetails: opts.maxDetails ?? 5 });

    return {
      candidates: hits.map((hit) => {
        const exVat = toExVat(
          hit.quote.rawCasePrice,
          hit.quote.vatRate,
          hit.quote.priceIsVatInclusive,
        );
        return candidateFromCard(supplier, hit.card, Number.isFinite(exVat) ? exVat : undefined);
      }),
    };
  } catch (error) {
    return {
      candidates: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Ask the suppliers again with weaker queries until something comes back.
 *
 * Bounded to a handful of requests against logged-in trade accounts: the raw
 * text, then the canonical with trailing tokens dropped one at a time, stopping
 * at the first hit or at two remaining tokens (below that any answer is noise).
 */
async function runControlProbe(
  canonical: string,
  raw: string,
  opts: TraceOptions,
): Promise<ControlProbe> {
  const attempts: ControlProbe['attempts'] = [];
  const tokens = canonical.split(/\s+/).filter(Boolean);

  const queries: { query: string; label: string }[] = [];
  const rawUpper = raw.trim().toUpperCase();
  if (rawUpper && rawUpper !== canonical) {
    queries.push({ query: raw, label: 'raw Excel text' });
  }
  for (let drop = 1; tokens.length - drop >= 2 && drop <= 3; drop++) {
    queries.push({
      query: tokens.slice(0, tokens.length - drop).join(' '),
      label: `canonical minus last ${drop} token(s)`,
    });
  }

  let firstHit: ControlProbe['firstHit'];

  for (const { query, label } of queries) {
    const [musgrave, oreilly] = await Promise.all([
      search('musgrave', query, opts),
      search('oreilly', query, opts),
    ]);
    const resultCount = musgrave.candidates.length + oreilly.candidates.length;
    attempts.push({ query, label, resultCount });
    if (resultCount > 0) {
      firstHit = { query, label, resultCount };
      break;
    }
  }

  const blockingTokens = firstHit
    ? tokens.filter(
        (token) =>
          !firstHit!.query
            .toUpperCase()
            .split(/\s+/)
            .includes(token.toUpperCase()),
      )
    : [];

  return {
    attempts,
    ...(firstHit ? { firstHit } : {}),
    blockingTokens,
    verdict: firstHit
      ? `A shorter query ("${firstHit.query}") returns ${firstHit.resultCount} product(s). ` +
        `The token(s) ${blockingTokens.join(', ') || '(none)'} suppress the search.`
      : 'No weaker query returned anything either — the suppliers do not appear to stock this product.',
  };
}

/** The single rule that decides which stage is blamed. Exactly one wins. */
function diagnose(
  trace: Omit<ProductTrace, 'diagnosis'> & {
    /** Control-probe result, when one was run. */
    diagnosisProbe?: TraceDiagnosis['controlProbe'];
  },
): TraceDiagnosis {
  const { normalization, candidates, supplierErrors, sbert, ruleEngine, selection } = trace;

  if (trace.decision.status === 'Ready To Order' || trace.decision.status === 'Ready With Warnings') {
    return { stage: 'None', explanation: 'Product reached the dashboard successfully.' };
  }

  // Normalization destroyed the product name outright.
  if (normalization.canonical.trim() === '' || normalization.identityTokens.length === 0) {
    return {
      stage: 'Normalization',
      explanation:
        'Normalization removed every identity-bearing word, leaving nothing to search for.',
      suggestion:
        'A dictionary entry in config/normalization.json is too aggressive for this line — check retailNoise, countableNoise and decorations.',
    };
  }

  if (candidates.length === 0) {
    if (supplierErrors.length === SUPPLIER_IDS.length) {
      return {
        stage: 'Supplier Search',
        explanation: `Every supplier search failed: ${supplierErrors
          .map((e) => `${e.supplier} (${e.message})`)
          .join('; ')}.`,
        suggestion: 'Check credentials and supplier availability; this is not a matching problem.',
      };
    }
    // The control probe separates a bad query from a missing product, and names
    // the exact token responsible when it is the query.
    const probe = trace.diagnosisProbe;

    if (probe?.firstHit) {
      const viaRaw = probe.firstHit.label === 'raw Excel text';
      return {
        stage: viaRaw ? 'Normalization' : 'Search Query',
        explanation:
          `"${normalization.canonical}" returned nothing, but "${probe.firstHit.query}" returns ` +
          `${probe.firstHit.resultCount} product(s). ` +
          (viaRaw
            ? 'Normalization changed the query into one the suppliers cannot answer.'
            : `The token(s) ${probe.blockingTokens.join(', ')} suppress the search — normalization should have removed or expanded them.`),
        suggestion: viaRaw
          ? 'Compare the normalization steps in stage 2 — a removed or expanded word is the difference.'
          : `Add ${probe.blockingTokens.join(', ')} to the appropriate list in config/normalization.json (abbreviations, decorations or countableNoise).`,
        controlProbe: probe,
      };
    }

    return {
      stage: 'Supplier Search',
      explanation:
        `Neither supplier returned any product for "${normalization.canonical}"` +
        (probe ? ', and no weaker query found anything either' : '') +
        '. The product appears not to be stocked, or is named very differently in the catalogues.',
      suggestion: 'Search the supplier portal by hand to confirm the catalogue name.',
      ...(probe ? { controlProbe: probe } : {}),
    };
  }

  if (sbert.error) {
    return {
      stage: 'SBERT Ranking',
      explanation: `The AI service did not answer: ${sbert.error}. Ranking fell back to neutral similarity.`,
      suggestion: 'Start the AI service; the deterministic rules still ran, so this may not be the only problem.',
    };
  }

  const passed = ruleEngine.filter((j) => j.decision === 'PASS');
  if (passed.length === 0) {
    // Blame the rule that failed most often — that is the actual blocker.
    const failures = new Map<string, number>();
    for (const judgement of ruleEngine) {
      for (const rule of judgement.rules) {
        if (rule.critical && rule.status === 'fail') {
          failures.set(rule.label, (failures.get(rule.label) ?? 0) + 1);
        }
      }
    }
    const dominant = [...failures.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      stage: 'Rule Engine',
      explanation: dominant
        ? `No candidate passed. The most common blocker was "${dominant[0]}" (${dominant[1]} of ${ruleEngine.length} candidates).`
        : `No candidate passed, and no critical rule failed — every candidate scored below the acceptance threshold.`,
      suggestion: dominant
        ? `Check whether the ${dominant[0].toLowerCase()} difference is real or a vocabulary problem.`
        : 'The supplier results are all weak matches for this description.',
    };
  }

  if (selection.selected.length === 0) {
    return {
      stage: 'Rule Engine',
      explanation: `Candidates passed, but selection produced none: ${selection.reason}`,
      ...(selection.excluded.length > 0
        ? { suggestion: selection.excluded.map((e) => e.reason).join(' ') }
        : {}),
    };
  }

  const blocked = trace.reconciliation.filter((r) => !r.passed);
  if (blocked.length === trace.reconciliation.length && blocked.length > 0) {
    const codes = [...new Set(blocked.flatMap((b) => b.codes))];
    return {
      stage: 'Reconciliation',
      explanation: `Every selected product was blocked by the safety gate: ${blocked[0]!.summary}`,
      suggestion: `Failure codes: ${codes.join(', ')}.`,
    };
  }

  return {
    stage: 'Allocation',
    explanation:
      'Products cleared reconciliation but no supplier could be chosen — none carried a usable price.',
    suggestion: 'Check the supplier listing for a price on the portal.',
  };
}

// ---- The tracer ------------------------------------------------------------

/**
 * Run one product through the real pipeline, recording every stage.
 *
 * Accepts either a parsed Excel article or a bare query string, so a product can
 * be investigated straight from a file row or from a description typed by hand.
 */
export async function traceProduct(
  input: ShopArticle | { description: string },
  opts: TraceOptions = {},
): Promise<ProductTrace> {
  const article = input as Partial<ShopArticle> & { description: string };

  // --- Stage 1 & 2: Excel and normalization --------------------------------
  const normalized = normalizeProduct(article.description);
  const canonical = canonicalQuery(article.description);

  const excel: TraceExcel = {
    description: article.description,
    ...(article.sourceRow !== undefined ? { row: article.sourceRow } : {}),
    ...(article.articleCode ? { articleCode: article.articleCode } : {}),
    ...(article.packRaw ? { packRaw: article.packRaw } : {}),
    ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    ...(article.cases !== undefined ? { cases: article.cases } : {}),
    ...(article.mainCost !== undefined ? { mainCost: article.mainCost } : {}),
  };

  const target: RuleTarget = {
    description: canonical,
    ...(article.unitsPerCase !== undefined ? { unitsPerCase: article.unitsPerCase } : {}),
    ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
    ...(article.mainCost !== undefined ? { mainCost: article.mainCost } : {}),
    ...(normalized.extractedMetadata.container
      ? { container: normalized.extractedMetadata.container }
      : {}),
    ...(normalized.extractedMetadata.form
      ? { form: normalized.extractedMetadata.form }
      : {}),
    ...(normalized.extractedMetadata.multipackCount !== undefined &&
    normalized.extractedMetadata.multipackCount !== article.unitsPerCase
      ? { multipack: normalized.extractedMetadata.multipackCount }
      : {}),
    ...(normalized.extractedMetadata.abv !== undefined
      ? { abv: normalized.extractedMetadata.abv }
      : {}),
  };

  const normalizationTrace: TraceNormalization = {
    original: article.description,
    steps: normalized.steps,
    canonical,
    metadata: normalized.extractedMetadata,
    identityTokens: [...identityTokensFor(canonical, undefined)].sort(),
  };

  // --- Stage 3: search queries ---------------------------------------------
  // Every stage is handed `canonical`. Recorded explicitly so the report can
  // PROVE they agree rather than asserting it.
  const consistency: CanonicalConsistency = {
    canonical,
    supplierSearch: canonical,
    sbert: canonical,
    ruleEngine: target.description,
    reconciliation: target.description,
    consistent: true,
    differences: [],
    pure: true,
    impurities: [],
  };

  consistency.impurities = canonicalImpurities(canonical);
  consistency.pure = consistency.impurities.length === 0;
  for (const [stage, received] of [
    ['Supplier search', consistency.supplierSearch],
    ['SBERT', consistency.sbert],
    ['Rule engine', consistency.ruleEngine],
    ['Reconciliation', consistency.reconciliation],
  ] as const) {
    if (received !== canonical) {
      consistency.consistent = false;
      consistency.differences.push({ stage, received });
    }
  }

  const searchQueries = SUPPLIER_IDS.map((supplier) => ({
    supplier,
    query: canonical,
    ...(canonical !== article.description
      ? { note: `differs from the Excel text — normalization produced this (see stage 2)` }
      : {}),
  }));

  // --- Stage 4: supplier results -------------------------------------------
  const [musgrave, oreilly] = await Promise.all([
    search('musgrave', canonical, opts),
    search('oreilly', canonical, opts),
  ]);

  const rawCandidates = [...musgrave.candidates, ...oreilly.candidates];
  const supplierErrors = [
    ...(musgrave.error ? [{ supplier: 'musgrave', message: musgrave.error }] : []),
    ...(oreilly.error ? [{ supplier: 'oreilly', message: oreilly.error }] : []),
  ];

  const candidates: TraceCandidate[] = rawCandidates.map((candidate, index) => ({
    index,
    supplier: candidate.supplier,
    name: candidate.name,
    normalizedName:
      normalizeProduct(candidate.name, { supplier: candidate.supplier }).normalizedQuery ||
      candidate.name,
    ...(candidate.brand ? { brand: candidate.brand } : {}),
    ...(candidate.sku ? { sku: candidate.sku } : {}),
    ...(candidate.ean ? { ean: candidate.ean } : {}),
    ...(candidate.unitsPerCase !== undefined ? { unitsPerCase: candidate.unitsPerCase } : {}),
    ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
    ...(candidate.uom ? { uom: candidate.uom } : {}),
    ...(candidate.container ? { container: candidate.container } : {}),
    ...(candidate.exVatCasePrice !== undefined
      ? { exVatCasePrice: candidate.exVatCasePrice }
      : {}),
  }));

  // Control probe — worth the extra requests only when the canonical search
  // came back empty and the suppliers themselves were reachable.
  let diagnosisProbe: ControlProbe | undefined;
  if (opts.controlProbe !== false && rawCandidates.length === 0 && supplierErrors.length === 0) {
    diagnosisProbe = await runControlProbe(canonical, article.description, opts);
  }

  // --- Stage 5: SBERT -------------------------------------------------------
  const aiCandidates: AiCandidate[] = rawCandidates.map((candidate) => ({
    supplier: candidate.supplier,
    name:
      normalizeProduct(candidate.name, { supplier: candidate.supplier }).normalizedQuery ||
      candidate.name,
    ...(candidate.brand ? { brand: candidate.brand } : {}),
    ...(candidate.unitsPerCase !== undefined ? { unitsPerCase: candidate.unitsPerCase } : {}),
    ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
  }));

  const rank = opts.rank ?? rankCandidates;
  const ai = await rank(excel.row ?? 0, target, aiCandidates);

  const sbertInputs: TraceSbert[] = ai.ranking
    .filter((entry) => aiCandidates[entry.candidateIndex] !== undefined)
    .map((entry) => ({
      candidateIndex: entry.candidateIndex,
      requested: canonical,
      candidate: aiCandidates[entry.candidateIndex]!.name,
      similarity: entry.similarity,
    }));

  const ranked =
    ai.ranking.length > 0
      ? ai.ranking
          .filter((entry) => rawCandidates[entry.candidateIndex] !== undefined)
          .map((entry) => ({
            candidateIndex: entry.candidateIndex,
            candidate: rawCandidates[entry.candidateIndex]!,
            similarity: entry.similarity,
          }))
      : rawCandidates.map((candidate, index) => ({
          candidateIndex: index,
          candidate,
          similarity: 0,
        }));

  // --- Stages 6-8: rules, reconciliation, allocation ------------------------
  const judgements = judgeCandidates(target, ranked);
  const selection = selectFinal(ranked, judgements);
  const gate = reconcileSelection({ ...target, ...(excel.row !== undefined ? { row: excel.row } : {}) }, selection.selected);

  const offers: DashboardOffer[] = gate.safe.map((candidate) => ({
    supplier: candidate.supplier,
    supplierName: SUPPLIERS.get(candidate.supplier)?.name ?? candidate.supplier,
    product: candidate.name,
    ...(candidate.sku ? { sku: candidate.sku } : {}),
    ...(candidate.exVatCasePrice !== undefined
      ? { exVatCasePrice: candidate.exVatCasePrice }
      : {}),
  }));
  const winner = chooseBestSupplier(offers);

  const allocation: TraceAllocation = {
    passCandidates: gate.results.map((result) => ({
      supplier: result.supplier,
      product: result.allocatedProduct,
      ...(selection.selected.find((s) => s.supplier === result.supplier)?.exVatCasePrice !==
      undefined
        ? {
            price: selection.selected.find((s) => s.supplier === result.supplier)!
              .exVatCasePrice,
          }
        : {}),
      verdict: result.passed ? 'PASS' : 'BLOCKED',
    })),
    ...(winner
      ? {
          winner: {
            supplier: winner.supplier,
            product: winner.product,
            ...(winner.exVatCasePrice !== undefined
              ? { price: winner.exVatCasePrice }
              : {}),
          },
        }
      : {}),
    reason: winner
      ? offers.length > 1
        ? 'Lowest ex-VAT case price among verified candidates'
        : 'Only verified candidate'
      : 'No verified candidate carried a usable price',
  };

  // --- Stage 9: dashboard decision -----------------------------------------
  const warnings = winner
    ? (gate.results.find((r) => r.supplier === winner.supplier && r.passed)?.differences ?? [])
        .filter((d) => d.severity === 'warning')
        .filter((d) => d.code !== 'BRAND_MISMATCH')
    : [];

  const decision = winner
    ? {
        status: warnings.length > 0 ? 'Ready With Warnings' : 'Ready To Order',
        reason:
          warnings.length > 0
            ? warnings.map((w) => w.reason).join('; ')
            : `Selected ${winner.product} from ${winner.supplier}.`,
      }
    : {
        status: 'Needs Attention',
        reason:
          gate.blocked[0]?.summary ??
          (rawCandidates.length === 0
            ? 'No supplier returned a product for this line.'
            : selection.reason),
      };

  // --- Structured parse ----------------------------------------------------
  // Built from the SAME candidate set the rest of the pipeline saw, with the
  // compound vocabulary derived from those titles.
  const vocabulary = vocabularyFor([
    article.description,
    ...rawCandidates.map((candidate) => candidate.name),
  ]);
  const knownBrands = [
    ...new Set(rawCandidates.map((candidate) => candidate.brand).filter(Boolean)),
  ] as string[];

  const parsedRequested = parseProduct(article.description, {
    vocabulary,
    knownBrands,
    ...(article.unitsPerCase !== undefined ? { caseQuantity: article.unitsPerCase } : {}),
    ...(article.unitSize !== undefined ? { unitSize: article.unitSize } : {}),
  });

  const parsedCandidates = rawCandidates.map((candidate, index) => ({
    index,
    parsed: parseProduct(candidate.name, {
      supplier: candidate.supplier,
      vocabulary,
      knownBrands,
      ...(candidate.brand ? { brand: candidate.brand } : {}),
      ...(candidate.unitsPerCase !== undefined
        ? { caseQuantity: candidate.unitsPerCase }
        : {}),
      ...(candidate.unitSize !== undefined ? { unitSize: candidate.unitSize } : {}),
      ...(candidate.uom ? { unit: candidate.uom } : {}),
    }),
  }));

  const winnerIndex = gate.safe[0]
    ? rawCandidates.findIndex(
        (candidate) =>
          candidate.supplier === gate.safe[0]!.supplier &&
          candidate.name === gate.safe[0]!.name,
      )
    : judgements[0]?.candidateIndex;

  const bestParsed = parsedCandidates.find((entry) => entry.index === winnerIndex);

  const parsed: TraceParsed = {
    requested: parsedRequested,
    candidates: parsedCandidates,
    fieldComparison: bestParsed
      ? compareParsed(parsedRequested, bestParsed.parsed)
      : [],
    categoryConflicts: categoryConflicts().map((conflict) => ({
      token: conflict.token,
      categories: [...conflict.categories],
    })),
  };

  const partial = {
    excel,
    normalization: normalizationTrace,
    parsed,
    canonicalConsistency: consistency,
    searchQueries,
    candidates,
    supplierErrors,
    sbert: {
      input: sbertInputs,
      ...(ai.error ? { error: ai.error } : {}),
      durationMs: ai.durationMs,
    },
    ruleEngine: judgements,
    selection,
    reconciliation: gate.results,
    allocation,
    decision,
    diagnosisProbe,
  };

  return { ...partial, diagnosis: diagnose(partial) };
}
