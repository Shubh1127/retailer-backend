/**
 * Explainability mode — the complete lifecycle of ONE product.
 *
 * Answers "which stage rejected this?" without anyone reading source. Every
 * transformation, every candidate, every rule and every verdict is printed, and
 * the report ends by naming exactly one stage as the root cause.
 *
 * Usage:
 *   npm run debug:product -- --row 35
 *   npm run debug:product -- --query "WRIGLEYS EXTRA PEPPERMINT GUM 46P"
 *   npm run debug:product -- --row 35 --file test-data/061025bjd.xls
 *   npm run debug:product -- --query "AIRWAVES BLACKMINT" --no-probe
 *   npm run debug:product -- --row 35 --json
 *
 * Needs the supplier credentials and, for stage 5, the AI service. Both degrade:
 * a supplier outage or a stopped AI service is reported as the diagnosis rather
 * than crashing the report.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';

import { importEposListing } from '../ingest/eposListing.js';
import { traceProduct, type ProductTrace } from '../services/productTrace.service.js';
import { checkAiService } from '../services/aiMatch.client.js';
import { resolveTestDataFile } from './testDataFile.js';
import type { ShopArticle } from '../ingest/eposListing.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

const rowArg = flag('row');
const queryArg = flag('query');
const outPath = flag('out');
const asJson = has('json');

if (!rowArg && !queryArg) {
  console.error('Specify --row <n> or --query "<description>".');
  process.exit(1);
}

// ---- Resolve the product ---------------------------------------------------

let subject: ShopArticle | { description: string };

if (rowArg) {
  const inputPath = resolveTestDataFile(flag('file'));
  const parsed = importEposListing(readFileSync(inputPath));
  const wanted = Number(rowArg);
  const article = parsed.articles.find((a) => a.sourceRow === wanted);

  if (!article) {
    console.error(`No product at Excel row ${wanted} in ${inputPath}.`);
    console.error(
      `Rows present: ${parsed.articles
        .slice(0, 12)
        .map((a) => a.sourceRow)
        .join(', ')}${parsed.articles.length > 12 ? ' …' : ''}`,
    );
    process.exit(1);
  }
  subject = article;
} else {
  subject = { description: queryArg! };
}

// ---- Render ----------------------------------------------------------------

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

function heading(title: string): void {
  console.log('');
  console.log(RULE);
  console.log(` ${title}`);
  console.log(RULE);
}

function field(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(24)} ${value === undefined || value === '' ? '—' : value}`);
}

function tick(pass: boolean | undefined): string {
  if (pass === undefined) return '·';
  return pass ? '✓' : '✗';
}

function render(trace: ProductTrace): void {
  // ---- 1. Excel -----------------------------------------------------------
  heading('STAGE 1 — ORIGINAL EXCEL DATA');
  field('Row', trace.excel.row);
  field('Article code', trace.excel.articleCode);
  field('Description', JSON.stringify(trace.excel.description));
  field(
    'Pack',
    trace.excel.unitsPerCase !== undefined && trace.excel.unitSize !== undefined
      ? `${trace.excel.unitsPerCase} x ${trace.excel.unitSize}`
      : (trace.excel.packRaw ?? undefined),
  );
  field('Cases', trace.excel.cases);
  field('Cost', trace.excel.mainCost);

  // ---- 2. Normalization ---------------------------------------------------
  heading('STAGE 2 — PRODUCT NORMALIZATION');
  console.log(`  Original   ${JSON.stringify(trace.normalization.original)}`);
  for (const step of trace.normalization.steps) {
    const changed = step.before !== step.after;
    console.log('       |');
    console.log(`       v  ${step.stage}: ${step.detail}`);
    console.log(
      `  ${changed ? '→' : ' '}          ${JSON.stringify(step.after)}${changed ? '' : '   (unchanged)'}`,
    );
  }
  console.log('');
  console.log(`  CANONICAL  ${JSON.stringify(trace.normalization.canonical)}`);
  console.log(`  Identity tokens: ${trace.normalization.identityTokens.join(', ') || '(none)'}`);

  const meta = trace.normalization.metadata;
  console.log('');
  console.log('  Metadata (set aside, not lost)');
  field('  Prices', meta.priceText.join(', '));
  field('  Retail flags', meta.retailFlags.join(', '));
  field('  Container', meta.container);
  field('  Product form', meta.form);
  field('  Piece count', meta.pieceCount);
  field('  Multipack count', meta.multipackCount);
  field('  Brands recognised', meta.brands.join(', '));
  field('  Expansions', meta.expansions.map((e) => `${e.from}→${e.to}`).join(', '));
  field('  Synonyms', meta.synonyms.map((s) => `${s.from}→${s.to}`).join(', '));
  field('  Decorations', meta.decorations.join(', '));

  // ---- Structured parse ---------------------------------------------------
  heading('PARSED PRODUCT (structured commercial data)');
  const requested = trace.parsed.requested;
  field('Brand', requested.brand);
  field('Product', requested.product);
  field('Variant', requested.variant);
  field('Form', requested.form);
  field('Container', requested.container);
  field('Multipack', requested.multipack);
  field('Piece count', requested.pieceCount);
  field('Unit size', requested.unitSize);
  field('Unit', requested.unit);
  field('Case quantity', requested.caseQuantity);
  console.log('');
  field('Canonical identity', JSON.stringify(requested.canonicalIdentity));
  if (requested.trace.compoundSplits.length > 0) {
    field(
      'Compound splits',
      requested.trace.compoundSplits.map((s) => `${s.from} → ${s.to}`).join(', '),
    );
  }
  if (trace.parsed.categoryConflicts.length > 0) {
    console.log('');
    console.log('  ✗ TOKENS IN MORE THAN ONE CATEGORY — every token must have exactly one:');
    for (const conflict of trace.parsed.categoryConflicts) {
      console.log(`      ${conflict.token}: ${conflict.categories.join(', ')}`);
    }
  }

  if (trace.parsed.fieldComparison.length > 0) {
    console.log('');
    console.log('  Field comparison (against the selected candidate)');
    for (const comparison of trace.parsed.fieldComparison) {
      const mark =
        comparison.verdict === 'match' ? '✓' : comparison.verdict === 'differ' ? '✗' : '·';
      console.log(
        `      ${mark} ${comparison.field.padEnd(14)} ${String(comparison.requested ?? '—').padEnd(22)} ${String(comparison.allocated ?? '—')}`,
      );
    }
  }

  // ---- Canonical consistency ---------------------------------------------
  heading('CANONICAL QUERY VERIFICATION');
  const c = trace.canonicalConsistency;
  field('Canonical', JSON.stringify(c.canonical));
  field('Supplier search', JSON.stringify(c.supplierSearch));
  field('SBERT', JSON.stringify(c.sbert));
  field('Rule engine', JSON.stringify(c.ruleEngine));
  field('Reconciliation', JSON.stringify(c.reconciliation));
  console.log('');
  // Consistency is necessary but NOT sufficient: a wrong canonical is applied
  // consistently wrongly by every stage.
  if (c.pure) {
    console.log('  ✓ Canonical contains commercial identity only — no retail metadata.');
  } else {
    console.log('  ✗ CANONICAL IS NOT PURE — it still carries retail metadata:');
    for (const impurity of c.impurities) {
      console.log(`      ${JSON.stringify(impurity.token)}  (${impurity.reason})`);
    }
    console.log('      These belong in metadata; they suppress supplier search.');
  }
  if (c.consistent) {
    console.log('  ✓ All four stages received the identical canonical string.');
  } else {
    console.log('  ✗ STAGES DISAGREE — a product is being judged against text it was not searched for:');
    for (const difference of c.differences) {
      console.log(`      ${difference.stage}: ${JSON.stringify(difference.received)}`);
    }
  }

  // ---- 3. Search queries --------------------------------------------------
  heading('STAGE 3 — SEARCH QUERY');
  for (const entry of trace.searchQueries) {
    console.log(`  ${entry.supplier.padEnd(10)} ${JSON.stringify(entry.query)}`);
    if (entry.note) console.log(`  ${' '.repeat(10)} ${entry.note}`);
  }

  // ---- 4. Supplier results ------------------------------------------------
  heading(`STAGE 4 — SUPPLIER RESULTS (${trace.candidates.length})`);
  if (trace.supplierErrors.length > 0) {
    for (const error of trace.supplierErrors) {
      console.log(`  ! ${error.supplier} FAILED — ${error.message.split('\n')[0]}`);
    }
    console.log('');
  }
  if (trace.candidates.length === 0) {
    console.log('  (no candidates returned)');
  }
  for (const candidate of trace.candidates) {
    console.log(THIN);
    console.log(`  [${candidate.index}] ${candidate.name}   (${candidate.supplier})`);
    field('  normalized', JSON.stringify(candidate.normalizedName));
    field(
      '  pack',
      candidate.unitsPerCase !== undefined && candidate.unitSize !== undefined
        ? `${candidate.unitsPerCase} x ${candidate.unitSize}${candidate.uom ?? ''}`
        : undefined,
    );
    field('  container', candidate.container);
    const parsedCandidate = trace.parsed.candidates.find((p) => p.index === candidate.index);
    if (parsedCandidate) {
      const p = parsedCandidate.parsed;
      field(
        '  parsed',
        `brand=${p.brand ?? '—'} product="${p.product}" variant=${p.variant ?? '—'} form=${p.form ?? '—'}`,
      );
    }
    field('  sku', candidate.sku);
    field('  ean', candidate.ean);
    field(
      '  ex-VAT case price',
      candidate.exVatCasePrice !== undefined ? `€${candidate.exVatCasePrice.toFixed(2)}` : undefined,
    );
  }

  // ---- 5. SBERT -----------------------------------------------------------
  heading('STAGE 5 — SBERT');
  if (trace.sbert.error) {
    console.log(`  ! AI service error — ${trace.sbert.error}`);
    console.log('    Ranking fell back to neutral similarity; the rules still ran.');
  } else if (trace.sbert.input.length === 0) {
    console.log('  (nothing to rank)');
  } else {
    console.log(`  Requested: ${JSON.stringify(trace.normalization.canonical)}`);
    console.log(`  (${trace.sbert.durationMs ?? 0}ms)`);
    console.log('');
    for (const entry of trace.sbert.input) {
      console.log(
        `  [${String(entry.candidateIndex).padStart(2)}] ${entry.similarity.toFixed(4)}  ${entry.candidate}`,
      );
    }
  }

  // ---- 6. Rule engine -----------------------------------------------------
  heading('STAGE 6 — RULE ENGINE');
  if (trace.ruleEngine.length === 0) console.log('  (no candidates judged)');
  for (const judgement of trace.ruleEngine) {
    console.log(THIN);
    console.log(
      `  [${judgement.candidateIndex}] ${judgement.candidate}   ${judgement.decision}`,
    );
    for (const rule of judgement.rules) {
      const mark = rule.status === 'pass' ? '✓' : rule.status === 'fail' ? '✗' : '·';
      const critical = rule.critical ? '' : ' (advisory)';
      console.log(
        `        ${mark} ${rule.label.padEnd(20)}${critical} ${rule.status === 'pass' ? '' : rule.detail}`,
      );
    }
    field('  SBERT similarity', judgement.sbertSimilarity.toFixed(4));
    field('  Final confidence', `${(judgement.finalConfidence * 100).toFixed(1)}%`);
    field('  Band', judgement.breakdown.band);
    if (judgement.decision !== 'PASS') field('  Reason', judgement.reason);
  }

  // ---- Selection ----------------------------------------------------------
  heading('SELECTION (one product per supplier)');
  field('Status', trace.selection.status);
  field('Reason', trace.selection.reason);
  for (const choice of trace.selection.selected) {
    console.log(`  ✔ ${choice.supplier.padEnd(10)} ${choice.name}`);
  }
  for (const exclusion of trace.selection.excluded) {
    console.log(`  ! ${exclusion.supplier} excluded — ${exclusion.reason}`);
  }

  // ---- 7. Reconciliation --------------------------------------------------
  heading('STAGE 7 — RECONCILIATION');
  if (trace.reconciliation.length === 0) console.log('  (nothing selected to reconcile)');
  for (const result of trace.reconciliation) {
    console.log(THIN);
    console.log(`  Requested   ${result.product}`);
    console.log(`  Allocated   ${result.allocatedProduct}   (${result.supplier})`);
    console.log('');

    // Show a verdict for every comparison, including the ones that passed
    // silently — "every rule must be shown".
    const byField = new Map(result.differences.map((d) => [d.field, d]));
    for (const field of [
      'variant',
      'productName',
      'brand',
      'unitsPerCase',
      'unitSize',
      'uom',
      'multipack',
      'container',
      'ean',
      'sku',
      'price',
    ]) {
      const difference = byField.get(field);
      const verdict = !difference
        ? 'PASS'
        : difference.severity === 'critical'
          ? 'FAIL'
          : 'WARN';
      const mark = verdict === 'PASS' ? '✓' : verdict === 'FAIL' ? '✗' : '!';
      console.log(
        `      ${mark} ${field.padEnd(14)} ${verdict}${difference ? `  ${difference.reason}` : ''}`,
      );
    }
    console.log('');
    console.log(`  RESULT      ${result.passed ? 'PASS' : 'FAIL'}   ${result.summary}`);
  }

  // ---- 8. Allocation ------------------------------------------------------
  heading('STAGE 8 — ALLOCATION');
  for (const candidate of trace.allocation.passCandidates) {
    console.log(
      `  ${candidate.supplier.padEnd(10)} ${candidate.price !== undefined ? `€${candidate.price.toFixed(2)}` : '—'.padEnd(7)}  ${candidate.verdict}  ${candidate.product}`,
    );
  }
  console.log('');
  if (trace.allocation.winner) {
    field('Winner', `${trace.allocation.winner.supplier} — ${trace.allocation.winner.product}`);
    field(
      'Price',
      trace.allocation.winner.price !== undefined
        ? `€${trace.allocation.winner.price.toFixed(2)}`
        : undefined,
    );
  } else {
    field('Winner', 'none');
  }
  field('Reason', trace.allocation.reason);

  // ---- 9. Dashboard decision ---------------------------------------------
  heading('STAGE 9 — DASHBOARD DECISION');
  field('Status', trace.decision.status);
  field('Reason', trace.decision.reason);

  // ---- Diagnosis ----------------------------------------------------------
  heading('FAILURE DIAGNOSIS');
  field('Failure category', trace.diagnosis.stage);
  console.log('');
  console.log(`  ${trace.diagnosis.explanation}`);
  if (trace.diagnosis.suggestion) {
    console.log('');
    console.log(`  Next step: ${trace.diagnosis.suggestion}`);
  }
  if (trace.diagnosis.controlProbe) {
    const probe = trace.diagnosis.controlProbe;
    console.log('');
    console.log('  Control probe (weaker queries re-searched)');
    for (const attempt of probe.attempts) {
      console.log(
        `    ${String(attempt.resultCount).padStart(3)} results  ${JSON.stringify(attempt.query)}  (${attempt.label})`,
      );
    }
    if (probe.blockingTokens.length > 0) {
      console.log(`    blocking token(s): ${probe.blockingTokens.join(', ')}`);
    }
    console.log(`    → ${probe.verdict}`);
  }
  console.log('');
}

// ---- Run -------------------------------------------------------------------

const ai = await checkAiService();
if (!ai.reachable) {
  console.log(`NOTE: AI service unreachable (${ai.error ?? 'no response'}).`);
  console.log('      Stage 5 will be empty; the deterministic stages still run.\n');
}

const trace = await traceProduct(subject, { controlProbe: !has('no-probe') });

if (asJson) {
  const text = JSON.stringify(trace, null, 2);
  if (outPath) {
    writeFileSync(outPath, text, 'utf8');
    console.log(`Trace written to ${outPath}`);
  } else {
    console.log(text);
  }
} else {
  render(trace);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(trace, null, 2), 'utf8');
    console.log(`Full trace also written to ${outPath}`);
  }
}
