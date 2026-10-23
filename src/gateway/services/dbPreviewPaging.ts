/**
 * Paging helpers for the app DB tab table preview (job and registry-linked DBs).
 * Inputs come from the UI over websocket, so they are clamped before they are
 * inlined into SQL.
 */

export const DEFAULT_PREVIEW_PAGE_SIZE = 50;
export const MAX_PREVIEW_PAGE_SIZE = 500;

export function normalizePreviewPaging(
  limit?: unknown,
  offset?: unknown,
): { limit: number; offset: number } {
  const l = Number(limit);
  const o = Number(offset);
  return {
    limit:
      Number.isFinite(l) && l >= 1
        ? Math.min(Math.floor(l), MAX_PREVIEW_PAGE_SIZE)
        : DEFAULT_PREVIEW_PAGE_SIZE,
    offset: Number.isFinite(o) && o >= 0 ? Math.floor(o) : 0,
  };
}

/** Stable page order: primary key columns when the table has them. */
export function previewOrderBy(
  columns: Array<{ name: string; pk: boolean }>,
): string {
  const pk = columns
    .filter((column) => column.pk)
    .map((column) => `"${column.name.replace(/"/g, '""')}"`);
  return pk.length > 0 ? ` ORDER BY ${pk.join(", ")}` : "";
}
