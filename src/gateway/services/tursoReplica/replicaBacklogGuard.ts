/**
 * Hold automatic uploads of a replica backlog that looks like churn, not data.
 *
 * A job that wipes and re-inserts the same rows on every run builds millions of pending
 * changes for a few thousand rows (papr-unit-economics: 5.3M changes for ~17K rows).
 * Uploading that is millions of Turso row writes to land the same rows, and big enough
 * backlogs never finish inside the push limit anyway. A real bulk import has about one
 * change per row, so the ratio of pending changes to live rows separates the two.
 */
export const BACKLOG_HOLD_MIN_PENDING = 250_000;
export const BACKLOG_HOLD_MIN_CHANGES_PER_ROW = 20;
export const BACKLOG_HOLD_PREFIX = "BACKLOG_HOLD:";

export interface BacklogAssessment {
  hold: boolean;
  pendingOps: number;
  liveRows: number;
  changesPerRow: number;
}

export function assessReplicaBacklog(pendingOps: number, liveRows: number): BacklogAssessment {
  const rows = Math.max(0, liveRows);
  const changesPerRow = pendingOps / Math.max(1, rows);
  return {
    hold: pendingOps >= BACKLOG_HOLD_MIN_PENDING && changesPerRow >= BACKLOG_HOLD_MIN_CHANGES_PER_ROW,
    pendingOps,
    liveRows: rows,
    changesPerRow,
  };
}

const INTERNAL_TABLE = /^(sqlite_|turso_|_papr_|__turso_|_litestream|_cf_)/i;

/** Rows in the database's own tables (sync bookkeeping tables excluded). */
export async function countLiveRows(
  run: (statements: { sql: string }[]) => Promise<{ rows: unknown[] }[]>,
): Promise<number> {
  const [tables] = await run([{ sql: "SELECT name FROM sqlite_master WHERE type='table'" }]);
  const names = (tables?.rows ?? [])
    .map((r) => String((r as { name?: unknown }).name ?? ""))
    .filter((n) => n && !INTERNAL_TABLE.test(n));
  if (names.length === 0) return 0;
  const counts = await run(
    names.map((n) => ({ sql: `SELECT count(*) AS n FROM "${n.replace(/"/g, '""')}"` })),
  );
  return counts.reduce((sum, r) => sum + Number((r.rows[0] as { n?: unknown })?.n ?? 0), 0);
}

export function formatBacklogHold(a: BacklogAssessment, jobNames: string[]): string {
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const likely = jobNames.length > 0 ? ` Likely cause: ${jobNames.map((j) => `"${j}"`).join(", ")}.` : "";
  return (
    `${BACKLOG_HOLD_PREFIX} Upload held: ${fmt(a.pendingOps)} pending changes for ${fmt(a.liveRows)} rows ` +
    `(${fmt(a.changesPerRow)} per row). This usually means a job rewrites the same rows on every run.` +
    `${likely} Fix the job to write only what changed, then either keep the cloud copy ` +
    `(repair_cloud_sync strategy accept_cloud, discards these local changes) or upload anyway ` +
    `(repair_cloud_sync strategy push).`
  );
}

export function isBacklogHoldError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(BACKLOG_HOLD_PREFIX);
}
