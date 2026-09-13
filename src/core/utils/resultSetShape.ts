/**
 * Result-set shape analysis — detect degenerate retrievals.
 *
 * WHY THIS EXISTS
 * ---------------
 * `gradeSearchOutcome` scores a search by WHERE the cited result landed. That
 * is the right axis for ranking quality, but it is blind to a failure mode we
 * measured in production:
 *
 *   query: "mini-app DB query pattern"  ->  10 results
 *   ranks 1,2,3 = byte-identical generated `db.ts` scaffolding, differing only
 *   in the `APP_ID` constant. similarity 0.7042999 vs 0.7041931 (equal to 4dp).
 *
 * Cite rank 1 and that search grades `cited_top_rank` = 5/5. A perfect score
 * for a result set whose effective k was 1. Feeding that back as a positive
 * label teaches the ranker that the flood was good.
 *
 * On disk: 98 of 110 `db.ts` files across 147 mini-apps are byte-identical
 * once the APP_ID line is removed. Generated scaffolding is the MAJORITY of
 * the code corpus, so this is structural, not incidental.
 *
 * A second, distinct signature is server-side hydration fan-out: N rows that
 * share one `id` and one `content` while carrying DIFFERENT metadata. Observed
 * with 20 rows collapsing to a single memory id, every `similarity_score`
 * equal to 0.5973358 at 7dp. That is a correctness bug, not a ranking miss,
 * and must be reported separately so it is not "fixed" by tuning the ranker.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This does not delete or reorder results. Retrieval sees what the server
 * returned. We only measure the shape so grading can stop rewarding it and the
 * agent can be told to narrow its filters.
 */

/** Above this share of repeats, the result set carries less than half the information its length implies. */
const DEGENERATE_DUPLICATE_RATIO = 0.5;

/**
 * Collapse incidental identifiers so generated scaffolding compares equal.
 *
 * Exact hashing does NOT catch the dominant case: the `db.ts` copies differ by
 * one UUID. Normalising UUIDs, long hex, and bare integers turns those into a
 * single group while leaving genuinely different code distinct.
 */
export function normalizeForDedupe(content: string): string {
  return content
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "\u0000UUID",
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, "\u0000HEX")
    .replace(/\b\d+\b/g, "\u0000N")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ShapeInput {
  id: string;
  content: string;
}

export interface ResultSetShape {
  total: number;
  /** Distinct memory ids. Fewer than `total` means the server repeated a row. */
  distinctIds: number;
  /** Distinct contents after identifier normalisation. */
  distinctContents: number;
  /** 1 - distinctContents/total. 0.8 => only a fifth of the set is new information. */
  duplicateRatio: number;
  /** Size of the largest near-identical group. */
  maxRepeat: number;
  /**
   * The same memory id returned more than once. Signature of server-side
   * hydration fan-out — a correctness bug, reported separately from ranking.
   */
  idFanOut: boolean;
  degenerate: boolean;
}

export function analyzeResultSetShape(
  candidates: readonly ShapeInput[],
): ResultSetShape {
  const total = candidates.length;
  if (total === 0) {
    return {
      total: 0,
      distinctIds: 0,
      distinctContents: 0,
      duplicateRatio: 0,
      maxRepeat: 0,
      idFanOut: false,
      degenerate: false,
    };
  }

  const ids = new Set<string>();
  const groups = new Map<string, number>();

  for (const candidate of candidates) {
    ids.add(candidate.id);
    const key = normalizeForDedupe(candidate.content);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const distinctContents = groups.size;
  const maxRepeat = Math.max(...groups.values());
  const duplicateRatio = 1 - distinctContents / total;
  const idFanOut = ids.size < total;

  return {
    total,
    distinctIds: ids.size,
    distinctContents,
    duplicateRatio: Number(duplicateRatio.toFixed(3)),
    maxRepeat,
    idFanOut,
    // A single result cannot be "mostly duplicates" — guard against total=1
    // scoring degenerate on a ratio of 0.
    degenerate:
      total > 1 && (idFanOut || duplicateRatio >= DEGENERATE_DUPLICATE_RATIO),
  };
}

/**
 * Operator-facing warning. Returns null when the set is healthy so callers can
 * omit the field entirely rather than emit reassuring noise on every search.
 *
 * Carries counts only — no query text, no memory content (D2).
 */
export function describeResultSetShape(shape: ResultSetShape): string | null {
  if (!shape.degenerate) return null;

  const parts: string[] = [
    `${shape.total} results collapse to ${shape.distinctContents} distinct item(s)`,
    `largest repeat ${shape.maxRepeat}x`,
  ];

  if (shape.idFanOut) {
    parts.push(
      `SERVER BUG: ${shape.total - shape.distinctIds} row(s) repeat an existing memory id ` +
        `(hydration fan-out — metadata and content may not correspond)`,
    );
  }

  return (
    `Degenerate result set — ${parts.join("; ")}. ` +
    `Ranks beyond the first of each group add no information. ` +
    `Narrow with projectId/projectType/fileName filters, or use grep/read_file for exact lookups.`
  );
}
