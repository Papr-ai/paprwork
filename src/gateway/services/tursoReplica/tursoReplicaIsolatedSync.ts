/**
 * Sync a replica through the out-of-process worker.
 *
 * The caller must have released its own handle on `localPath` first — the worker opens the
 * same files, and two sync engines on one replica corrupt its WAL state.
 */

import * as fs from "fs";
import { ensureTursoSyncBridge } from "../TursoSyncBridge.js";
import { getTursoReplicaSyncWorkerClient } from "./TursoReplicaSyncWorkerClient.js";
import {
  isTursoSyncWorkerCrash,
  type TursoSyncWorkerOp,
} from "./tursoReplicaSyncWorkerProtocol.js";
import { resetReplicaSidecars } from "./tursoReplicaSidecarWedge.js";

const ISOLATED_SYNC_TIMEOUT_MS = 30_000;

export interface IsolatedReplicaSyncOptions {
  op: TursoSyncWorkerOp;
  localPath: string;
  tursoDatabase: string;
}

/**
 * Returns the result of pull() (false for push-only ops).
 *
 * If the worker is killed by the engine, the replica is left in whatever state caused the
 * abort — so reset its sidecars and retry once against a clean bootstrap before giving up.
 * A second crash is reported as a normal error: the gateway stays up either way.
 */
export async function runIsolatedReplicaSync(
  options: IsolatedReplicaSyncOptions,
): Promise<boolean> {
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    throw new Error("Turso sync bridge not available — sign in to Papr");
  }

  const client = getTursoReplicaSyncWorkerClient();

  const send = async (): Promise<boolean> => {
    const localReplicaExists = fs.existsSync(options.localPath);
    const creds = await bridge.resolveCredentialsForReplicaOpen(
      options.tursoDatabase,
      { localReplicaExists },
    );
    return client.runSync({
      op: options.op,
      localPath: options.localPath,
      tursoUrl: creds.tursoUrl,
      authToken: creds.authToken,
      bootstrapIfEmpty: !localReplicaExists,
      timeoutMs: ISOLATED_SYNC_TIMEOUT_MS,
    });
  };

  try {
    return await send();
  } catch (error) {
    if (!isTursoSyncWorkerCrash(error)) {
      throw error;
    }
    console.warn(
      `[TursoReplica] Sync worker aborted during ${options.op} on ${options.localPath} — ` +
        `resetting sidecars and retrying once. ${(error as Error).message}`,
    );
    resetReplicaSidecars(options.localPath);
    return await send();
  }
}
