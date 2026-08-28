/**
 * Cloud agent sandbox: query Turso primary directly instead of hydrating ephemeral
 * local SQLite replicas (avoids costly full-table pull/push on every run).
 */

import path from "path";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { isTursoReplicaSyncFeatureEnabled } from "../../utils/tursoReplicaEnabled.js";
import type { CloudTursoSource } from "./types.js";

export function isCloudRunSandbox(paprHome?: string): boolean {
  const home = paprHome ?? getPaprRoot();
  return (
    home.includes(`${path.sep}papr-cloud-run${path.sep}`) ||
    home.includes(`${path.sep}papr-cloud-session${path.sep}`)
  );
}

/** True when cloud sandbox jobs/backends should use Turso HTTP (not local SQLite). */
export function shouldUseCloudSandboxTursoDirect(paprHome?: string): boolean {
  if (process.env.PAPR_CLOUD_SANDBOX_TURSO_DIRECT === "0") {
    return false;
  }
  if (process.env.PAPR_CLOUD_SANDBOX_TURSO_DIRECT === "1") {
    return isCloudRunSandbox(paprHome);
  }
  return isCloudRunSandbox(paprHome) && isTursoReplicaSyncFeatureEnabled();
}

export interface CloudSandboxTursoCredentials {
  url: string;
  authToken: string;
}

/** Map registry dbId → Turso creds from memory-prepared cloud agent request. */
export function tursoCredsByDbIdFromCloudSources(
  sources: readonly CloudTursoSource[] | undefined,
): Map<string, CloudSandboxTursoCredentials> {
  const map = new Map<string, CloudSandboxTursoCredentials>();
  for (const source of sources ?? []) {
    if (!source.syncKey.startsWith("db-")) {
      continue;
    }
    map.set(source.syncKey, {
      url: source.databaseUrl,
      authToken: source.authToken,
    });
  }
  return map;
}
