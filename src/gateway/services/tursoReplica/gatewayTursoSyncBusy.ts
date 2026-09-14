/**
 * Marks gateway sync-busy while Turso replica pull/push runs so Electron supervisor
 * does not treat slow /health as a dead process.
 */

import * as path from "path";
import {
  clearGatewaySyncBusy,
  markGatewaySyncBusy,
} from "../cloudSync/syncBusyState.js";

function replicaBusyAppId(localPath: string): string {
  return `replica:${path.basename(path.dirname(localPath))}`;
}

export async function withTursoReplicaSyncBusy<T>(
  localPath: string,
  trigger: string,
  fn: () => Promise<T>,
): Promise<T> {
  markGatewaySyncBusy({
    appId: replicaBusyAppId(localPath),
    operation: "turso_replica",
    startedAtMs: Date.now(),
    trigger,
    replicaPath: path.normalize(localPath),
  });
  try {
    return await fn();
  } finally {
    clearGatewaySyncBusy();
  }
}
