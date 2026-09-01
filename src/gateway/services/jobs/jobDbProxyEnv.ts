/**
 * Gateway proxy credentials for jobs that write to a Turso-synced replica.
 *
 * A replica's sync engine tracks its position as a byte offset into the WAL.
 * SQLite auto-checkpoints when the last connection closes, truncating the WAL
 * to zero and invalidating that offset — the next push then fails with
 * "short read on WAL frame at offset N". A job holding a raw write handle is
 * therefore enough to wedge the database, and a *scheduled* job re-wedges it
 * on a timer.
 *
 * Mini-app backends already avoid this by writing through the gateway
 * (mintBackendDbProxyEnv). Jobs were handed a raw file path instead. This
 * closes that gap using the same session mechanism, so there is one writer.
 */

import {
  mintBackendDbProxyEnv,
  revokeBackendDbProxyToken,
} from "../appRuntime/backendDbProxy.js";
import {
  isReplicaManagedTarget,
  type JobWriteDatabaseTarget,
} from "../jobAppDatabase.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18789);

/** Job runs are long-lived compared to a backend action; give tokens room. */
const JOB_PROXY_TTL_MS = 6 * 60 * 60 * 1000;

export interface JobDbProxyLease {
  env: Record<string, string>;
  release: () => void;
}

const NO_LEASE: JobDbProxyLease = { env: {}, release: () => {} };

/**
 * Mint a proxy session when any write target is replica-managed.
 *
 * `appId` scopes the session exactly as the mini-app path does, so a job can
 * only reach databases linked to the app it belongs to.
 */
export function leaseJobDbProxyEnv(
  targets: readonly JobWriteDatabaseTarget[],
  appId: string | undefined,
): JobDbProxyLease {
  const replicaTarget = targets.find(isReplicaManagedTarget);
  if (!replicaTarget || !appId) {
    return NO_LEASE;
  }

  const env = mintBackendDbProxyEnv({
    appId,
    sourceId: replicaTarget.alias,
    proxyBaseUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
    ttlMs: JOB_PROXY_TTL_MS,
  });

  // PAPR_DB_MODE is owned by jobWriteDatabaseEnv ("replica"), which tells
  // papr_db to read locally and write through the proxy. mintBackendDbProxyEnv
  // sets it to "proxy" for the app-backend case, where reads go through the
  // proxy too. Drop it here so the job-side mode survives.
  const { PAPR_DB_MODE: _ignored, ...proxyEnv } = env;

  return {
    env: proxyEnv,
    release: () => revokeBackendDbProxyToken(env.PAPR_DB_PROXY_TOKEN),
  };
}
