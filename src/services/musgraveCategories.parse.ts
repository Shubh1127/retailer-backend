/**
 * Musgrave Category API — parsing only.
 *
 * Turns the nested API document into the flat, depth-first PRE-ORDERED payload
 * the persistence layer applies. Pre-order matters: the SQL apply resolves each
 * node's parent by `parentCategoryRef`, so a parent must always appear before its
 * children.
 *
 * Nothing is discarded. Every documented field gets a typed slot, array ORDER is
 * captured in `position`, and each node's verbatim JSON (minus `subCategories`,
 * which become rows of their own) is kept in `rawNode` so the exact API document
 * can be reproduced.
 *
 * Pure and synchronous — no network, no database — so the whole shape-handling
 * surface is unit-testable against recorded responses.
 */

import { createLogger } from '../log.js';

const log = createLogger('musgrave:categories:parse');

// ---------------------------------------------------------------------------
// Raw API shapes (index signatures: Intershop adds fields without notice)
// ---------------------------------------------------------------------------

export interface MusgraveApiCategoryAttribute {
  name?: string;
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface MusgraveApiCategoryPathEntry {
  id?: string;
  categoryRef?: string;
  name?: string;
  type?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface MusgraveApiCategory {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  online?: boolean | string | number;
  categoryRef?: string;
  uri?: string;
  hasOnlineSubCategories?: boolean | string | number;
  hasOnlineProducts?: boolean | string | number;
  attributes?: MusgraveApiCategoryAttribute[];
  categoryPath?: MusgraveApiCategoryPathEntry[];
  subCategories?: MusgraveApiCategory[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Flat payload — the contract with musgrave_sync_category_tree()
// ---------------------------------------------------------------------------

export interface FlatCategoryAttribute {
  position: number;
  name: string;
  type?: string;
  /** Exactly one of the four value slots is populated. */
  valueText?: string;
  valueNumber?: number;
  valueBoolean?: boolean;
  valueJson?: unknown;
}

export interface FlatCategoryPathEntry {
  position: number;
  categoryId: string;
  categoryRef?: string;
  name?: string;
  type?: string;
  uri?: string;
}

export interface FlatCategoryNode {
  categoryRef: string;
  musgraveId: string;
  name: string;
  type?: string;
  description?: string;
  online?: boolean;
  /** The `online` field exactly as sent, since the API has used both forms. */
  onlineRaw?: string;
  hasOnlineSubCategories?: boolean;
  hasOnlineProducts?: boolean;
  uri?: string;
  parentCategoryRef?: string;
  depth: number;
  /** Index among its siblings — preserves the API's ordering. */
  position: number;
  /** Zero-padded materialized path, e.g. "0003.0011" — deterministic tree order. */
  sortPath: string;
  rawNode: Record<string, unknown>;
  attributes: FlatCategoryAttribute[];
  path: FlatCategoryPathEntry[];
}

export interface ParsedCategoryTree {
  nodes: FlatCategoryNode[];
  /** Non-fatal shape problems worth surfacing (missing refs, duplicates). */
  warnings: string[];
  counts: { categories: number; attributes: number; paths: number; maxDepth: number };
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

const TRUE_STRINGS = new Set(['true', '1', 'yes', 'y', 'online']);
const FALSE_STRINGS = new Set(['false', '0', 'no', 'n', 'offline']);

/** The API has shipped booleans as `true`, `"true"`, `"1"` and `1`. */
export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) return true;
    if (FALSE_STRINGS.has(normalized)) return false;
  }
  return undefined;
}

function toText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Route an attribute value to its natural column. */
export function splitAttributeValue(
  value: unknown,
): Pick<FlatCategoryAttribute, 'valueText' | 'valueNumber' | 'valueBoolean' | 'valueJson'> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'boolean') return { valueBoolean: value };
  if (typeof value === 'number') {
    // Infinity/NaN have no numeric SQL representation; keep them readable.
    return Number.isFinite(value) ? { valueNumber: value } : { valueText: String(value) };
  }
  if (typeof value === 'string') return { valueText: value };
  // Objects and arrays (e.g. Intershop "Money") keep their structure.
  return { valueJson: value };
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Root extraction
// ---------------------------------------------------------------------------

/**
 * Pull the top-level categories out of the response envelope.
 *
 * Intershop wraps collections differently across resources and versions, so every
 * plausible envelope is accepted rather than assuming one: a bare array,
 * `{ elements }`, `{ categories }`, `{ data }`, `{ subCategories }`, or a single
 * root category object.
 */
export function extractRootCategories(payload: unknown): MusgraveApiCategory[] {
  if (payload === null || payload === undefined) return [];

  if (Array.isArray(payload)) return payload as MusgraveApiCategory[];

  if (typeof payload !== 'object') return [];

  const record = payload as Record<string, unknown>;

  for (const key of ['elements', 'categories', 'data', 'subCategories'] as const) {
    const value = record[key];
    if (Array.isArray(value)) return value as MusgraveApiCategory[];
    // Some envelopes nest one more level: { data: { elements: [...] } }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = extractRootCategories(value);
      if (nested.length > 0) return nested;
    }
  }

  // A single category document with no envelope.
  if (typeof record.id === 'string' || typeof record.categoryRef === 'string') {
    return [record as MusgraveApiCategory];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

function parseAttributes(
  raw: MusgraveApiCategoryAttribute[] | undefined,
  categoryRef: string,
  warnings: string[],
): FlatCategoryAttribute[] {
  if (!Array.isArray(raw)) return [];

  const attributes: FlatCategoryAttribute[] = [];
  const seen = new Set<string>();

  raw.forEach((attribute, index) => {
    const name = typeof attribute?.name === 'string' ? attribute.name.trim() : '';
    if (!name) {
      warnings.push(`Category ${categoryRef}: attribute at index ${index} has no name — skipped.`);
      return;
    }
    // Names are the relational key; a repeat would silently overwrite on upsert.
    if (seen.has(name)) {
      warnings.push(`Category ${categoryRef}: duplicate attribute "${name}" — keeping the first.`);
      return;
    }
    seen.add(name);

    attributes.push({
      position: index,
      name,
      ...(toText(attribute.type) !== undefined ? { type: toText(attribute.type) } : {}),
      ...splitAttributeValue(attribute.value),
    });
  });

  return attributes;
}

function parseCategoryPath(
  raw: MusgraveApiCategoryPathEntry[] | undefined,
  categoryRef: string,
  warnings: string[],
): FlatCategoryPathEntry[] {
  if (!Array.isArray(raw)) return [];

  const path: FlatCategoryPathEntry[] = [];

  raw.forEach((entry, index) => {
    const categoryId = toText(entry?.id) ?? toText(entry?.categoryRef);
    if (!categoryId) {
      warnings.push(`Category ${categoryRef}: categoryPath[${index}] has no id — skipped.`);
      return;
    }
    path.push({
      position: index,
      categoryId,
      ...(toText(entry.categoryRef) !== undefined ? { categoryRef: toText(entry.categoryRef) } : {}),
      ...(toText(entry.name) !== undefined ? { name: toText(entry.name) } : {}),
      ...(toText(entry.type) !== undefined ? { type: toText(entry.type) } : {}),
      ...(toText(entry.uri) !== undefined ? { uri: toText(entry.uri) } : {}),
    });
  });

  return path;
}

/** The node's own JSON, minus the children that become rows in their own right. */
function rawNodeOf(category: MusgraveApiCategory): Record<string, unknown> {
  const { subCategories: _subCategories, ...rest } = category;
  return rest as Record<string, unknown>;
}

/**
 * Flatten the API tree into pre-ordered nodes.
 *
 * `categoryRef` is the relational identity. When the API omits it, one is
 * synthesized from the parent ref and the node id so the hierarchy still
 * persists — recorded as a warning rather than dropping the branch.
 */
export function parseCategoryTree(payload: unknown): ParsedCategoryTree {
  const roots = extractRootCategories(payload);
  const nodes: FlatCategoryNode[] = [];
  const warnings: string[] = [];
  const seenRefs = new Set<string>();

  let attributeCount = 0;
  let pathCount = 0;
  let maxDepth = 0;

  const visit = (
    category: MusgraveApiCategory,
    parentCategoryRef: string | undefined,
    depth: number,
    position: number,
    parentSortPath: string,
  ): void => {
    const musgraveId = toText(category?.id) ?? toText(category?.categoryRef);
    let categoryRef = toText(category?.categoryRef);

    if (!categoryRef) {
      const fallbackId = musgraveId ?? `index-${position}`;
      categoryRef = parentCategoryRef ? `${parentCategoryRef}/${fallbackId}` : fallbackId;
      warnings.push(
        `Category "${category?.name ?? fallbackId}" has no categoryRef — synthesized "${categoryRef}".`,
      );
    }

    if (!musgraveId) {
      warnings.push(`Category ${categoryRef} has no id — using its categoryRef.`);
    }

    if (seenRefs.has(categoryRef)) {
      // Two nodes claiming one ref would upsert over each other and could reparent
      // a whole branch. Keep the first and skip the repeat.
      warnings.push(`Duplicate categoryRef "${categoryRef}" — subsequent occurrence skipped.`);
      return;
    }
    seenRefs.add(categoryRef);

    const sortPath = parentSortPath ? `${parentSortPath}.${pad(position)}` : pad(position);
    const attributes = parseAttributes(category?.attributes, categoryRef, warnings);
    const path = parseCategoryPath(category?.categoryPath, categoryRef, warnings);

    attributeCount += attributes.length;
    pathCount += path.length;
    maxDepth = Math.max(maxDepth, depth);

    const online = toBoolean(category?.online);
    const onlineRaw = toText(category?.online);
    const hasOnlineSubCategories = toBoolean(category?.hasOnlineSubCategories);
    const hasOnlineProducts = toBoolean(category?.hasOnlineProducts);
    const type = toText(category?.type);
    const description = toText(category?.description);
    const uri = toText(category?.uri);

    nodes.push({
      categoryRef,
      musgraveId: musgraveId ?? categoryRef,
      name: toText(category?.name) ?? categoryRef,
      depth,
      position,
      sortPath,
      rawNode: rawNodeOf(category ?? {}),
      attributes,
      path,
      ...(type !== undefined ? { type } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(online !== undefined ? { online } : {}),
      ...(onlineRaw !== undefined ? { onlineRaw } : {}),
      ...(hasOnlineSubCategories !== undefined ? { hasOnlineSubCategories } : {}),
      ...(hasOnlineProducts !== undefined ? { hasOnlineProducts } : {}),
      ...(uri !== undefined ? { uri } : {}),
      ...(parentCategoryRef !== undefined ? { parentCategoryRef } : {}),
    });

    const children = Array.isArray(category?.subCategories) ? category.subCategories : [];
    children.forEach((child, childIndex) => {
      visit(child, categoryRef, depth + 1, childIndex, sortPath);
    });
  };

  roots.forEach((root, index) => visit(root, undefined, 0, index, ''));

  const result: ParsedCategoryTree = {
    nodes,
    warnings,
    counts: {
      categories: nodes.length,
      attributes: attributeCount,
      paths: pathCount,
      maxDepth,
    },
  };

  log.info('Parsed category tree', result.counts);
  if (warnings.length > 0) {
    log.warn(`${warnings.length} parse warning(s)`, { first: warnings[0] });
  }

  return result;
}
