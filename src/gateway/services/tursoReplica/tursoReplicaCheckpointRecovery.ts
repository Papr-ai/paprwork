/**
 * Shared checkpoint / WAL wedge detection for Turso Sync replica paths.
 */

export function isReplicaCheckpointWalError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("checkpoint") ||
    lower.includes("unable to checkpoint synced portion of wal") ||
    lower.includes("sync engine operation failed")
  );
}

export function isReplicaReadTransportError(message: string): boolean {
  return (
    isReplicaCheckpointWalError(message) ||
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
