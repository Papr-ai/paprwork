/**
 * Turso Sync connect helpers — provisioning retry (Turso host race after token mint).
 */

import { connect, type Database } from "@tursodatabase/sync";
import type { DatabaseOpts } from "@tursodatabase/sync";
import type { TursoReplicaConnectOptions } from "./tursoReplicaTypes.js";

const RETRY_DELAYS_MS = [0, 1500, 3000, 5000, 8000] as const;

export type PaprTursoSyncConnectOpts = DatabaseOpts & {
  bootstrapIfEmpty?: boolean;
};

export function isTursoHostNotReadyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("404") ||
    msg.includes("Host not found") ||
    msg.includes("not found")
  );
}

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
