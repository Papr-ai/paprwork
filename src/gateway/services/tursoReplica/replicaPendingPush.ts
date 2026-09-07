/**
 * Shared replica pending-push logic for live worker probes and registry cache.
 */

export function computeReplicaPendingPush(input: {
  pendingOps: number;
  lastPushError?: string | null;
  migrationConflict?: boolean;
  lastReplicaPushAt?: string | null;
  lastReplicaLocalMutationAt?: string | null;
}): boolean {
  const pendingOps = input.pendingOps;
  const lastPushError = input.lastPushError?.trim() || null;
  const migrationConflict = input.migrationConflict === true;

  const pushAtMs = input.lastReplicaPushAt
    ? Date.parse(input.lastReplicaPushAt)
    : 0;
  const mutationAtMs = input.lastReplicaLocalMutationAt
    ? Date.parse(input.lastReplicaLocalMutationAt)
    : 0;
  const pushCoversLocalMutations =
    pushAtMs > 0 && (mutationAtMs === 0 || pushAtMs >= mutationAtMs);

  if (pendingOps > 0) {
    // db.stats().cdcOperations can stay >0 after a successful push when fossilized
    // legacy turso_cdc rows remain — trust push/mutation timestamps in that case.
    if (
      !migrationConflict &&
      !lastPushError &&
      pushCoversLocalMutations
    ) {
      return false;
    }
    return true;
  }
  if (migrationConflict) {
    return true;
  }
  if (lastPushError) {
    // Stale registry error after a successful push — don't block the UI forever.
    return !(pushCoversLocalMutations && pendingOps === 0);
  }
  if (mutationAtMs > 0 && (pushAtMs === 0 || pushAtMs < mutationAtMs)) {
    // Publish can touch the registry a few ms after pushAt; with zero CDC ops that
    // is bookkeeping skew, not real unpublished data.
    if (pendingOps === 0 && pushAtMs > 0 && mutationAtMs - pushAtMs <= 5_000) {
      return false;
    }
    return true;
  }
  return false;
}
