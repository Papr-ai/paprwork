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

/** One retry after 400ms, on 5xx/429 responses only. */
const TRANSIENT_STATUS_RETRY_DELAY_MS = 400;

/**
 * Absorb a single transient Turso 5xx/429 inside the engine.
 *
 * Kept deliberately small: this runs inside the replica's sync lane, so every
 * retry delays reads and writes queued on that path. Thrown fetch errors
 * (offline, DNS) are NOT retried — offline is common and waiting would only
 * hold the lane; the push scheduler already retries those on its own clock.
 * Not the SDK's retryFetch for that reason (it retries thrown errors, 3x).
 */
export async function retryTransientTursoStatus(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status < 500 && first.status !== 429) {
    return first;
  }
  await first.body?.cancel().catch(() => undefined);
  await sleep(TRANSIENT_STATUS_RETRY_DELAY_MS);
  return fetch(input, init);
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
    fetch: retryTransientTursoStatus,
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
