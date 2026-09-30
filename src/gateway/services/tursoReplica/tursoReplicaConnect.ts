/**
 * Turso Sync connect helper — WORKER PROCESS ONLY.
 *
 * This is the single runtime import of `@tursodatabase/sync` in the codebase. It must only
 * be reached from tursoReplicaSyncWorkerEntry.ts; the gateway process talks to the engine
 * through TursoReplicaSyncWorkerClient. See tests/turso-native-import-guard.test.ts.
 */

import { connect, type Database } from "@tursodatabase/sync";
import type { DatabaseOpts } from "@tursodatabase/sync";
import type { TursoReplicaConnectOptions } from "./tursoReplicaTypes.js";
import { isTursoHostNotReadyError } from "./tursoReplicaErrors.js";

const RETRY_DELAYS_MS = [0, 1500, 3000, 5000, 8000] as const;

export type PaprTursoSyncConnectOpts = DatabaseOpts & {
  bootstrapIfEmpty?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectTursoReplica(
  options: TursoReplicaConnectOptions,
): Promise<Database> {
  const connectOpts: PaprTursoSyncConnectOpts = {
    path: options.localPath,
    url: options.tursoUrl,
    authToken: options.authToken,
    clientName: options.clientName ?? "paprwork-desktop",
    bootstrapIfEmpty: options.bootstrapIfEmpty ?? true,
    remoteWritesExperimental: options.remoteWritesExperimental ?? false,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay > 0) {
      await sleep(delay);
    }
    try {
      const db = await connect(connectOpts);
      await db.connect();
      return db;
    } catch (error) {
      lastError = error;
      if (
        !isTursoHostNotReadyError(error) ||
        attempt === RETRY_DELAYS_MS.length - 1
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export { isTursoHostNotReadyError };
