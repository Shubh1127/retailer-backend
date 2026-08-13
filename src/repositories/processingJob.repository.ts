/**
 * Supabase persistence for processing jobs.
 *
 * Durability, not liveness: the in-process `JobRegistry` serves the running
 * dashboard, and these writes are what make a job still exist tomorrow. That
 * split is why every function here is BEST-EFFORT — a Supabase hiccup must
 * degrade the job history, never kill a run that is mid-way through 2000 live
 * supplier searches.
 *
 * When Supabase is not configured at all (no SUPABASE_URL), every call becomes a
 * no-op and reports it once. The dashboard then works exactly as before, minus
 * the history — which is the right trade for a local dev machine.
 */

import { getSupabaseClient } from '../db/supabase.js';
import { createLogger } from '../log.js';
import type { JobSummary } from '../jobs/processingJob.js';
import type {
  NeedsAttentionRow,
  ProcessedArticle,
  ReadyToOrderRow,
} from '../services/dashboardPipeline.service.js';

const log = createLogger('job-repository');

let unavailableReported = false;

/** Supabase, or null when unconfigured. Never throws. */
function client() {
  try {
    return getSupabaseClient();
  } catch (error) {
    if (!unavailableReported) {
      unavailableReported = true;
      log.warn('Supabase not configured — job history will not be persisted', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

export function isPersistenceEnabled(): boolean {
  return client() !== null;
}

/**
 * Describe a failure in a way that can actually be acted on.
 *
 * Supabase does NOT throw `Error`s — it returns a plain `PostgrestError` object
 * of `{ message, details, hint, code }`. The previous version fell through to
 * `String(error)` for anything that was not an `Error`, which printed
 * "[object Object]" and threw away every useful field: the message, the
 * Postgres error code, and the hint that usually names the exact column.
 *
 * A persistence failure is already invisible by design — it is best-effort and
 * the run continues — so the log line is the only evidence it happened. It has
 * to say what went wrong.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (error && typeof error === 'object') {
    const { message, details, hint, code } = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };

    const parts = [
      typeof message === 'string' ? message : undefined,
      typeof details === 'string' && details ? `details: ${details}` : undefined,
      typeof hint === 'string' && hint ? `hint: ${hint}` : undefined,
      typeof code === 'string' && code ? `code: ${code}` : undefined,
    ].filter(Boolean);

    // A shape we did not anticipate is still better serialized than stringified.
    if (parts.length > 0) return parts.join(' · ');
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through to String() below */
    }
  }

  return String(error);
}

/**
 * Logged at ERROR, not WARN.
 *
 * Every call here means rows were accepted by the pipeline and then thrown
 * away — the job history for those products no longer exists anywhere. Being
 * best-effort makes that survivable for the RUN; it does not make it a minor
 * event. A `warn` is what let an entire upload's rows disappear unnoticed until
 * an admin clicked a product and got "has no row 238", which names neither the
 * cause nor the fix.
 *
 * PostgREST rejects the WHOLE row for one unknown column, so the overwhelmingly
 * likely cause is a table that predates a migration. The pointer is included
 * because the log line is the only evidence this happened.
 */
function fail(action: string, error: unknown): void {
  log.error(`Job persistence failed — rows discarded: ${action}`, {
    error: describe(error),
    hint:
      'A missing column rejects the entire row. Check with ' +
      '`npx tsx src/scripts/checkJobColumns.ts`, apply supabase/migrations in ' +
      "filename order, then run `notify pgrst, 'reload schema';` — PostgREST " +
      'serves a cached schema and rejects a column it has not re-read yet.',
  });
}

/** Insert a newly created job. */
export async function insertJob(summary: JobSummary, userId?: string): Promise<void> {
  const db = client();
  if (!db) return;

  const { error } = await db.from('processing_jobs').insert({
    job_id: summary.jobId,
    file_name: summary.fileName,
    store_name: summary.storeName ?? null,
    status: summary.status,
    total_products: summary.totalProducts,
    processed_products: summary.processedProducts,
    ready_products: summary.readyProducts,
    needs_attention_products: summary.needsAttentionProducts,
    created_at: summary.createdAt,
    user_id: userId ?? null,
  });

  if (error) fail('insertJob', error);
}

/** Update the counters and status after a batch, or at the end of a run. */
export async function updateJob(summary: JobSummary): Promise<void> {
  const db = client();
  if (!db) return;

  const { error } = await db
    .from('processing_jobs')
    .update({
      status: summary.status,
      total_products: summary.totalProducts,
      processed_products: summary.processedProducts,
      ready_products: summary.readyProducts,
      needs_attention_products: summary.needsAttentionProducts,
      started_at: summary.startedAt ?? null,
      completed_at: summary.completedAt ?? null,
      error: summary.error ?? null,
    })
    .eq('job_id', summary.jobId);

  if (error) fail('updateJob', error);
}

function readyRecord(jobId: string, row: ReadyToOrderRow, audit?: ProcessedArticle) {
  const selected = row.detail.selected;
  return {
    job_id: jobId,
    source_row: row.row,
    article_code: row.articleCode,
    requested_product: row.product,
    requested_pack: row.detail.requestedPack ?? null,
    cases: row.cases,
    supplier_id: row.bestSupplier,
    supplier_name: row.bestSupplierName,
    selected_product: selected?.product ?? row.product,
    supplier_sku: selected?.sku ?? null,
    ean: selected?.ean ?? null,
    ex_vat_case_price: row.price,
    units_per_case: selected?.unitsPerCase ?? null,
    unit_size: selected?.unitSize ?? null,
    uom: selected?.uom ?? null,
    savings: row.savings ?? null,
    savings_pct: row.savingsPct ?? null,
    savings_basis: row.savingsStatus,
    baseline_cost: row.baselineCost ?? null,
    cost_delta: row.costDelta ?? null,
    dashboard_status: row.warnings.length > 0 ? 'ready-with-warnings' : 'ready',
    warnings: row.warnings,
    admin_confirmed: row.adminConfirmed ?? null,
    ean_confirmed: row.eanConfirmed ?? null,
    added_to_cart: row.addedToCart === 'Yes',
    alternatives: row.detail.alternatives,
    offers: row.detail.offers,
    reconciliation: audit?.reconciliations ?? null,
    judgements: audit?.judgements ?? null,
  };
}

function attentionRecord(jobId: string, row: NeedsAttentionRow, audit?: ProcessedArticle) {
  return {
    job_id: jobId,
    source_row: row.row,
    article_code: row.articleCode,
    requested_product: row.product,
    status: row.status,
    reason: row.reason,
    suggestion: row.suggestion,
    failure_codes: row.codes,
    diagnostics: audit?.diagnostics ?? null,
    // What was asked for, kept beside why it could not be filled — an admin
    // settling this line by hand should not have to reopen the source file to
    // find out how many of what.
    requested_pack: row.requestedPack ?? null,
    cases: row.cases,
  };
}

/**
 * Persist one batch's rows.
 *
 * Upserted on (job_id, source_row) so a retried batch corrects its rows instead
 * of duplicating them — the one-row-per-product invariant has to survive a
 * retry, not just a clean run.
 */
export async function saveBatch(
  jobId: string,
  ready: readonly ReadyToOrderRow[],
  attention: readonly NeedsAttentionRow[],
  audits: readonly ProcessedArticle[] = [],
): Promise<void> {
  const db = client();
  if (!db) return;

  const auditByRow = new Map(audits.map((item) => [item.row.row, item]));

  if (ready.length > 0) {
    const { error } = await db
      .from('processed_products')
      .upsert(
        ready.map((row) => readyRecord(jobId, row, auditByRow.get(row.row))),
        { onConflict: 'job_id,source_row' },
      );
    if (error) fail('saveBatch(ready)', error);
  }

  if (attention.length > 0) {
    const { error } = await db
      .from('attention_products')
      .upsert(
        attention.map((row) => attentionRecord(jobId, row, auditByRow.get(row.row))),
        { onConflict: 'job_id,source_row' },
      );
    if (error) fail('saveBatch(attention)', error);
  }
}

/**
 * The stored offer matching a supplier + SKU, and its image.
 *
 * Matched on SKU when there is one, because a supplier can appear in `offers`
 * more than once. Falls back to supplier alone, which is right for the older
 * rows written before SKUs were carried consistently.
 */
function imageOf(
  offers: unknown,
  supplierId: unknown,
  supplierSku: unknown,
): string | undefined {
  if (!Array.isArray(offers)) return undefined;

  const match = offers.find((offer: Record<string, unknown>) => {
    if (offer?.supplier !== supplierId) return false;
    return supplierSku ? offer.sku === supplierSku : true;
  }) as Record<string, unknown> | undefined;

  return typeof match?.imageUrl === 'string' ? match.imageUrl : undefined;
}

export interface SavingsWindow {
  /** Jobs this retailer uploaded inside the window. */
  jobs: number;
  /** Lines those jobs produced that reached a supplier selection. */
  lines: number;
  /** Σ(savings × cases), ex-VAT. Only genuine savings count — see below. */
  savings: number;
  /**
   * Σ(baseline_cost × cases) — what those same lines would have cost at the
   * retailer's own current prices. The denominator for "% of weekly spend".
   *
   * Counts ONLY lines that have a baseline, because a line with no stated
   * current cost contributes nothing to the numerator either. Including its
   * supplier price in the denominator would quietly shrink the percentage by
   * adding spend that was never compared.
   */
  baseline: number;
}

/**
 * What this retailer actually saved over a window.
 *
 * Computed from the stored rows rather than the job summaries: `processing_jobs`
 * counts products, not money, so the figures have to come from the lines.
 *
 * Returns zeros rather than throwing when persistence is off — a landing page
 * must not fail because there is no database behind it.
 */
export async function savingsSince(
  since: string,
  userId?: string,
): Promise<SavingsWindow> {
  const empty: SavingsWindow = { jobs: 0, lines: 0, savings: 0, baseline: 0 };

  const db = client();
  if (!db) return empty;

  let jobQuery = db
    .from('processing_jobs')
    .select('job_id')
    .gte('created_at', since);

  // Scoped to the caller. An admin passing no id would otherwise be shown the
  // whole platform's savings as their own.
  if (userId) jobQuery = jobQuery.eq('user_id', userId);

  const { data: jobRows, error: jobError } = await jobQuery;

  if (jobError) {
    fail('savingsSince(jobs)', jobError);
    return empty;
  }

  const jobIds = (jobRows ?? []).map((row: Record<string, any>) => row.job_id);
  if (jobIds.length === 0) return empty;

  const { data: rows, error } = await db
    .from('processed_products')
    .select('savings, baseline_cost, cases')
    .in('job_id', jobIds);

  if (error) {
    fail('savingsSince(rows)', error);
    return empty;
  }

  let savings = 0;
  let baseline = 0;
  let lines = 0;

  for (const row of (rows ?? []) as Record<string, any>[]) {
    const cases = Number(row.cases ?? 1);
    const baselineCost = row.baseline_cost === null ? undefined : Number(row.baseline_cost);

    lines += 1;

    if (baselineCost === undefined || !Number.isFinite(baselineCost)) continue;
    baseline += baselineCost * cases;

    // `savings` is null unless the supplier genuinely beat the retailer's own
    // cost, so a dearer line contributes 0 rather than a negative — the same
    // rule the dashboard renders by.
    const saved = row.savings === null ? 0 : Number(row.savings);
    if (Number.isFinite(saved) && saved > 0) savings += saved * cases;
  }

  return {
    jobs: jobIds.length,
    lines,
    savings: Number(savings.toFixed(2)),
    baseline: Number(baseline.toFixed(2)),
  };
}

export interface StoredJob {
  summary: JobSummary;
  readyToOrder: ReadyToOrderRow[];
  needsAttention: NeedsAttentionRow[];
}

function toSummary(record: Record<string, any>): JobSummary {
  const total = Number(record.total_products ?? 0);
  const processed = Number(record.processed_products ?? 0);
  return {
    jobId: record.job_id,
    fileName: record.file_name,
    status: record.status,
    createdAt: record.created_at,
    totalProducts: total,
    processedProducts: processed,
    readyProducts: Number(record.ready_products ?? 0),
    needsAttentionProducts: Number(record.needs_attention_products ?? 0),
    progress: total > 0 ? Math.round((processed / total) * 100) : 0,
    ...(record.store_name ? { storeName: record.store_name } : {}),
    ...(record.user_id ? { userId: String(record.user_id) } : {}),
    ...(record.started_at ? { startedAt: record.started_at } : {}),
    ...(record.completed_at ? { completedAt: record.completed_at } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

/**
 * Job history, newest first. Empty when persistence is off.
 *
 * `userId` scopes the list to one uploader. Omitting it returns every job, which
 * is what an administrator sees — so the caller has to decide deliberately
 * rather than getting everyone's uploads by forgetting an argument.
 */
export async function listJobs(limit = 50, userId?: string): Promise<JobSummary[]> {
  const db = client();
  if (!db) return [];

  let query = db
    .from('processing_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query;

  if (error) {
    fail('listJobs', error);
    return [];
  }
  return (data ?? []).map(toSummary);
}

/** One stored job with its rows — the job-details page and report download. */
export async function loadJob(jobId: string): Promise<StoredJob | null> {
  const db = client();
  if (!db) return null;

  const { data: jobRow, error: jobError } = await db
    .from('processing_jobs')
    .select('*')
    .eq('job_id', jobId)
    .maybeSingle();

  if (jobError) {
    fail('loadJob', jobError);
    return null;
  }
  if (!jobRow) return null;

  const [ready, attention] = await Promise.all([
    db.from('processed_products').select('*').eq('job_id', jobId).order('source_row'),
    db.from('attention_products').select('*').eq('job_id', jobId).order('source_row'),
  ]);

  if (ready.error) fail('loadJob(ready)', ready.error);
  if (attention.error) fail('loadJob(attention)', attention.error);

  return {
    summary: toSummary(jobRow),
    readyToOrder: (ready.data ?? []).map(
      (record: Record<string, any>): ReadyToOrderRow => ({
        kind: 'ready',
        row: record.source_row,
        articleCode: record.article_code ?? '',
        product: record.requested_product,
        bestSupplier: record.supplier_id,
        bestSupplierName: record.supplier_name ?? record.supplier_id,
        price: Number(record.ex_vat_case_price ?? 0),
        cases: Number(record.cases ?? 1),
        addedToCart: record.added_to_cart ? 'Yes' : 'No',
        savingsStatus: record.savings_basis ?? 'no-baseline',
        warnings: record.warnings ?? [],
        ...(record.admin_confirmed ? { adminConfirmed: record.admin_confirmed } : {}),
        ...(record.ean_confirmed ? { eanConfirmed: record.ean_confirmed } : {}),
        ...(record.savings !== null ? { savings: Number(record.savings) } : {}),
        ...(record.savings_pct !== null ? { savingsPct: Number(record.savings_pct) } : {}),
        ...(record.baseline_cost !== null && record.baseline_cost !== undefined
          ? { baselineCost: Number(record.baseline_cost) }
          : {}),
        ...(record.cost_delta !== null && record.cost_delta !== undefined
          ? { costDelta: Number(record.cost_delta) }
          : {}),
        detail: {
          requestedProduct: record.requested_product,
          ...(record.requested_pack ? { requestedPack: record.requested_pack } : {}),
          selected: {
            supplier: record.supplier_id,
            supplierName: record.supplier_name ?? record.supplier_id,
            product: record.selected_product,
            ...(record.supplier_sku ? { sku: record.supplier_sku } : {}),
            ...(record.ean ? { ean: record.ean } : {}),
            ...(record.ex_vat_case_price !== null
              ? { exVatCasePrice: Number(record.ex_vat_case_price) }
              : {}),
            ...(record.units_per_case !== null
              ? { unitsPerCase: Number(record.units_per_case) }
              : {}),
            ...(record.unit_size !== null ? { unitSize: Number(record.unit_size) } : {}),
            ...(record.uom ? { uom: record.uom } : {}),
            // Recovered from the offers jsonb rather than stored in a column of
            // its own. `selected` is reassembled here from individual columns,
            // so anything without one is lost on reload — but the selected
            // product is ALWAYS among `offers` (it is chosen from them), and
            // that column is jsonb, so the image survives there for free. This
            // keeps a live job and a reloaded one showing the same thing
            // without another migration.
            ...(imageOf(record.offers, record.supplier_id, record.supplier_sku)
              ? {
                  imageUrl: imageOf(
                    record.offers,
                    record.supplier_id,
                    record.supplier_sku,
                  )!,
                }
              : {}),
          },
          alternatives: record.alternatives ?? [],
          offers: record.offers ?? [],
        },
      }),
    ),
    needsAttention: (attention.data ?? []).map(
      (record: Record<string, any>): NeedsAttentionRow => ({
        kind: 'attention',
        row: record.source_row,
        articleCode: record.article_code ?? '',
        product: record.requested_product,
        status: record.status,
        reason: record.reason,
        suggestion: record.suggestion ?? '',
        codes: record.failure_codes ?? [],
        ...(record.requested_pack ? { requestedPack: record.requested_pack } : {}),
        // Older rows predate the column. One case is what the parser defaults
        // to, so it is the honest reading of a row that never stored a count.
        cases: record.cases ?? 1,
      }),
    ),
  };
}
