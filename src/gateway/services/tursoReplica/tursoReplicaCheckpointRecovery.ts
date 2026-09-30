/**
 * Shared checkpoint / WAL wedge detection for Turso Sync replica paths.
 */

/** Turso cloud unreachable — recover in background, never reset sidecars. */
export function isReplicaNetworkFetchError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("fetch error") ||
    lower.includes("fetch failed") ||
    lower.includes("connect timeout") ||
    lower.includes("und_err_connect_timeout") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("network request failed")
  );
}

export function isReplicaCheckpointWalError(message: string): boolean {
  if (isReplicaNetworkFetchError(message)) {
    return false;
  }
  const lower = message.toLowerCase();
  return (
    lower.includes("unable to checkpoint synced portion of wal") ||
    lower.includes("short read on wal frame") ||
    (lower.includes("checkpoint") && lower.includes("wal"))
  );
}

export function isReplicaReadTransportError(message: string): boolean {
  return (
    isReplicaCheckpointWalError(message) ||
    isReplicaNetworkFetchError(message) ||
    message.includes("timed out after") ||
    message.includes("REPLICA_GEN_DRIFT")
  );
}

/** SQL/schema errors — same on replica and Turso primary; primary fallback cannot help. */
export function isReplicaSqlSchemaError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no such column:") ||
    lower.includes("no such table:") ||
    lower.includes("parse error:") ||
    lower.includes("sqlite input error:") ||
    lower.includes("has no column named") ||
    lower.includes("statement has been finalized")
  );
}
