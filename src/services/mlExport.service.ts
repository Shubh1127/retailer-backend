/**
 * Training-data export.
 *
 * The Query Understanding model is trained offline, in Python, from the product
 * catalogue this backend already syncs into Supabase. This module is the ONLY
 * bridge between the two: the dataset builder reads pages from here and never
 * touches the database, so Supabase credentials stay on the backend and the
 * training pipeline has one contract to depend on rather than a schema.
 *
 * READ ONLY, and paginated by design
 * ----------------------------------
 * 38k Musgrave products today, another ~30k O'Reilly products later. The caller
 * walks pages; nothing here ever holds the whole catalogue. That is not a
 * premature optimisation — it is the difference between an export that keeps
 * working as the catalogue grows and one that has to be rewritten when it does.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * No labelling, no normalization, no query generation. Those belong to the
 * dataset builder, where they can be inspected, versioned and re-run without a
 * backend deploy. This layer hands over verbatim catalogue text.
 */

import {
  SupabaseMusgraveProductRepository,
  type MlExportProductRow,
  type MusgraveProductRepository,
} from '../repositories/musgraveProduct.repository.js';
import { createLogger } from '../log.js';

const log = createLogger('ml:export');

/** PostgREST caps a response at 1000 rows, so no page can usefully exceed it. */
export const MAX_PAGE_SIZE = 1000;

/** Big enough that 38k products is 38 requests, not 380. */
export const DEFAULT_PAGE_SIZE = 500;

export interface MlExportPageResponse {
  /** Rows in this page, ordered by SKU. */
  products: MlExportProductRow[];
  /** Exportable rows in total — named products only. */
  total: number;
  limit: number;
  offset: number;
  count: number;
  /**
   * Offset of the next page, or null when this page was the last. The caller
   * loops until it is null rather than doing offset arithmetic of its own.
   */
  nextOffset: number | null;
}

export class MlExportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MlExportError';
  }
}

/**
 * Parse and bound the paging parameters.
 *
 * A bad `limit` is rejected rather than silently clamped: a builder asking for
 * 100000 rows has a bug, and quietly serving it 1000 makes that bug look like a
 * short catalogue instead of a misconfiguration.
 */
export function readPageParams(params: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = params.get('limit');
  const rawOffset = params.get('offset');

  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new MlExportError(400, `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MlExportError(400, 'offset must be an integer of 0 or more');
  }

  return { limit, offset };
}

/**
 * One page of Musgrave products for the dataset builder.
 *
 * Never throws a raw database error at the caller: a Supabase failure becomes a
 * 502 with the reason logged, because the export being unavailable is an
 * upstream problem, not a bad request from the builder.
 */
export async function exportMusgraveProducts(
  options: { limit: number; offset: number },
  repository: MusgraveProductRepository = new SupabaseMusgraveProductRepository(),
): Promise<MlExportPageResponse> {
  const { limit, offset } = options;

  let page;
  try {
    page = await repository.exportForMl({ limit, offset });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Musgrave product export failed', { limit, offset, message });
    throw new MlExportError(502, `Could not read the product catalogue: ${message}`);
  }

  const nextOffset = offset + page.products.length;
  // A short page is the end of the table. Comparing against `total` as well
  // means a page that is short only because rows were filtered still terminates.
  const hasMore = page.products.length === limit && nextOffset < page.total;

  log.info('Musgrave product export page served', {
    limit,
    offset,
    count: page.products.length,
    total: page.total,
  });

  return {
    products: page.products,
    total: page.total,
    limit,
    offset,
    count: page.products.length,
    nextOffset: hasMore ? nextOffset : null,
  };
}
