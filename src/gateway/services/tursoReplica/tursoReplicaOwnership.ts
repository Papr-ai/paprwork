/**
 * Which sync engine owns a registry database — a durable property of the
 * record, not of the runtime rollout flag.
 *
 * `shouldUseTursoReplicaForDb()` answers a different question: whether the
 * replica engine can be *used* right now. That needs the rollout flag and the
 * native binding, because routing a read through an engine that is not loaded
 * cannot work. Ownership is not conditional in the same way: once a database
 * has been cut over (or created) as `syncMode: "replica"`, its file and its
 * remote belong to the replica engine whatever this process believes today.
 *
 * Conflating the two let the legacy engine adopt an already-cutover database
 * whenever the flag was absent, and reconcile it against a remote it does not
 * own — shipping the same migrations every 20s, forever, because the drift it
 * measured was never its to heal.
 */

import type { DatabaseSyncMode } from "./tursoReplicaTypes.js";
import {
  isTursoReplicaNativeAvailable,
  tursoReplicaRolloutMode,
} from "../../utils/tursoReplicaEnabled.js";

export interface ReplicaOwnershipRecord {
  dbId?: string;
  localPath?: string;
  syncMode?: DatabaseSyncMode;
  cutoverAt?: string;
}

/**
 * True when the registry assigns this database to the replica engine.
 *
 * `syncMode` alone is the marker. `cutoverAt` corroborates it for migrated
 * databases but is absent on ones created replica-native, so requiring it
 * would leave those to the legacy engine.
 */
export function isReplicaOwnedRecord(
  record: ReplicaOwnershipRecord | undefined,
): boolean {
  return record?.syncMode === "replica";
}

const warnedDbIds = new Set<string>();

/** Why the replica engine is not available, for the operator-facing warning. */
function replicaEngineUnavailableReason(): string | null {
  if (!isTursoReplicaNativeAvailable()) {
    return `no @tursodatabase/sync binding for ${process.platform}-${process.arch}`;
  }
  if (tursoReplicaRolloutMode() === "off") {
    return "PAPR_TURSO_REPLICA_SYNC is unset or off";
  }
  return null;
}

/**
 * Report, once per database, that a replica-owned database has no engine to
 * sync it.
 *
 * Declining is correct — the legacy engine reconciling this database would
 * write to a remote it does not own — but silently declining is how the
 * original defect hid: sync simply stopped working with no line saying so.
 */
export function warnReplicaOwnedWithoutEngine(
  record: ReplicaOwnershipRecord,
): void {
  const reason = replicaEngineUnavailableReason();
  if (!reason) {
    return;
  }
  const key = record.dbId ?? record.localPath ?? "unknown";
  if (warnedDbIds.has(key)) {
    return;
  }
  warnedDbIds.add(key);
  console.warn(
    `[TursoReplica] ${key} is registered syncMode=replica but the replica engine is inactive (${reason}). ` +
      "Legacy sync will not adopt it — this database will not sync until the replica engine is enabled.",
  );
}

export function resetReplicaOwnershipWarningsForTests(): void {
  warnedDbIds.clear();
}
