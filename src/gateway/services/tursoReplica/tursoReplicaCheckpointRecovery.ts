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
