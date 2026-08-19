/**
 * GraphQL helpers for wiki home / entity fetches — escaping, filters, staggering.
 */

export const WIKI_HOME_REMOTE_CACHE_TTL_MS = 30 * 60 * 1000;
export const WIKI_REMOTE_FETCH_BATCH_SIZE = 2;
export const WIKI_REMOTE_FETCH_BATCH_DELAY_MS = 200;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape a value embedded in a GraphQL string literal. */
export function escapeGraphQL(value: string): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Sanitize user/graph-provided filter values before embedding in GraphQL.
 * Returns null when the value cannot be represented safely.
 */
export function sanitizeGraphQLFilterValue(
  value: string,
  maxLen = 240,
): string | null {
  const trimmed = value.replace(/[\r\n\t]/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  const clipped = trimmed.length > maxLen ? trimmed.slice(0, maxLen).trim() : trimmed;
  if (!clipped) {
    return null;
  }
  // Strip characters that would break out of a string literal or map literal.
  const cleaned = clipped.replace(/["\\{}]/g, "").trim();
  return cleaned || null;
}

/** Neo4j GraphQL scalar filters require `{ eq: "..." }`, not a bare string. */
export function graphqlStringEq(field: string, value: string): string | null {
  const safe = sanitizeGraphQLFilterValue(value);
  if (!safe) {
    return null;
  }
  return `${field}: { eq: "${escapeGraphQL(safe)}" }`;
}

/** Memory GraphQL uses StringScalarFilters: `{ name: { contains: "..." } }`. */
export function graphqlNameContainsWhere(label: string): string | null {
  const safe = sanitizeGraphQLFilterValue(label);
  if (!safe) {
    return null;
  }
  // StringScalarFilters nested form — name_CONTAINS is not a valid *Where field.
  return `{ name: { contains: "${escapeGraphQL(safe)}" } }`;
}

/** Validate an inline selection set fragment before wrapping in `{ ... }`. */
export function assertValidWikiGraphQLSelection(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Empty GraphQL selection");
  }
  if (/^\s*(mutation|subscription)\b/i.test(trimmed)) {
    throw new Error("Wiki GraphQL supports read queries only");
  }
  // NOTE: nested `{ contains: "..." }` is the CORRECT server syntax.
  // The memory GraphQL API exposes StringScalarFilters { eq, in, contains,
  // startsWith, endsWith }, so `where: { name: { contains: "Dria" } }` is valid
  // and `name_CONTAINS` does NOT exist on *Where types. A previous guard here
  // rejected the valid form and pushed callers toward a field that 400s.
  if (/[\r\n]/.test(trimmed)) {
    throw new Error("GraphQL selection must not contain raw newlines");
  }
}

export function wrapWikiGraphQLSelection(selection: string): string {
  assertValidWikiGraphQLSelection(selection);
  return `{ ${selection.trim()} }`;
}

/** Run async work in small parallel batches with a pause between batches. */
export async function runInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const size = Math.max(1, batchSize);
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    if (offset > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
    const batch = items.slice(offset, offset + size);
    const batchResults = await Promise.all(
      batch.map((item, batchIndex) => fn(item, offset + batchIndex)),
    );
    results.push(...batchResults);
  }
  return results;
}
