/**
 * Error classifiers shared by the gateway and the sync worker. No native imports here.
 */

export function isTursoHostNotReadyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("404") ||
    msg.includes("Host not found") ||
    msg.includes("not found")
  );
}

/**
 * Contention, not damage: someone else holds the file right now.
 *
 * Deliberately separate from `isReplicaReadTransportError`. That classifier's
 * recovery resets the sync sidecars, which is the right remedy for a wedged
 * WAL and the wrong one here — a lock means the previous holder is mid-flight,
 * so the fix is to wait, not to operate on its files. The engine sets no
 * `busy_timeout` (see `connectTursoReplica`), so nothing waits unless we do.
 */
export function isReplicaBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("database is locked") ||
    lower.includes("database table is locked") ||
    lower.includes("sqlite_busy")
  );
}

/**
 * Matches the message as well as the code, because only one of the two engines
 * on these files sets a code. better-sqlite3 raises `code: "SQLITE_BUSY"`;
 * `@tursodatabase/sync` surfaces a bare "database is locked". Checking the code
 * alone meant every caller's "DB busy, defer and try later" branch quietly
 * never ran for replica-backed databases, turning a wait into a hard failure.
 */
export function isSqliteBusyError(error: unknown): boolean {
  const hasBusyCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_BUSY";

  return hasBusyCode || isReplicaBusyError(error);
}
