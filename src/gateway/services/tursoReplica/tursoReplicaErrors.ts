/**
 * Error classifiers shared by the gateway and the sync worker. No native imports here.
 */

/**
 * Matches TursoReplicaSyncWorkerClient.assertNotCrashLooping's parked error, in
 * both its session and cross-restart wordings. A parked replica is a sync-layer
 * state (corrupt pages / crash loop), not a broken data-source link.
 */
export function isParkedReplicaError(error: unknown): boolean {
  const msg =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Turso replica .+ is parked(?: for this session)?:/.test(msg);
}

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

/**
 * The remote (Turso) refused or could not be reached: an HTTP status from the
 * sync protocol, or a fetch that never completed. Nothing local was touched —
 * the engine fails these before applying anything — so the open handle is
 * still good and closing it only forces the next caller to reopen, which may
 * itself need the same failing remote (bootstrap-pending replicas).
 */
export function isReplicaRemoteHttpError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("remote server returned an error") ||
    lower.includes("unexpected status code") ||
    lower.includes("fetch error") ||
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("und_err_connect_timeout")
  );
}
