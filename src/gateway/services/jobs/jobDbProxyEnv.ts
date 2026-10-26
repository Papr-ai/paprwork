/**
 * Gateway proxy credentials for jobs that write to a Turso-synced replica.
 */

import {
  mintBackendDbProxyEnv,
  revokeBackendDbProxyToken,
} from "../appRuntime/backendDbProxy.js";
import {
  isReplicaManagedTarget,
  type JobWriteDatabaseTarget,
} from "../jobAppDatabase.js";
import { STANDALONE_APP_ID } from "../jobs/appIds.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18789);
const JOB_PROXY_TTL_MS = 6 * 60 * 60 * 1000;

export interface JobDbProxyLease {
  env: Record<string, string>;
  release: () => void;
}

const NO_LEASE: JobDbProxyLease = { env: {}, release: () => {} };

/**
 * Mint a proxy session when any write target is replica-managed.
 * Uses app scope when linked; otherwise resolves by registry dbId.
 */
export function leaseJobDbProxyEnv(
  targets: readonly JobWriteDatabaseTarget[],
  appId: string | undefined,
): JobDbProxyLease {
  const replicaTarget = targets.find(isReplicaManagedTarget);
  if (!replicaTarget) {
    return NO_LEASE;
  }

  const linkedAppId =
    appId && appId !== STANDALONE_APP_ID ? appId : undefined;

  // The session lists every replica-managed database the job may write, so a
  // job can name one by dbId, registry label, or its app's alias — and a job
  // with two such databases can reach both (not just the first).
  const allowedDbIds = targets.filter(isReplicaManagedTarget).map((t) => t.dbId);

  const env = mintBackendDbProxyEnv({
    appId: linkedAppId ?? STANDALONE_APP_ID,
    sourceId: replicaTarget.alias,
    registryDbId: linkedAppId ? undefined : replicaTarget.dbId,
    allowedDbIds,
    proxyBaseUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
    ttlMs: JOB_PROXY_TTL_MS,
  });

  const { PAPR_DB_MODE: _ignored, ...proxyEnv } = env;

  return {
    env: proxyEnv,
    release: () => revokeBackendDbProxyToken(env.PAPR_DB_PROXY_TOKEN),
  };
}
