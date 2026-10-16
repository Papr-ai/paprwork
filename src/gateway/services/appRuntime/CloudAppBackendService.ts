/**
 * Cloud App Host backend executor — runs handlers at the edge from cached repo files.
 *
 * Handlers are bundled at publish time (backend/bundle.json) and served from git
 * via fetchCachedRuntimeRepoFile. Vault keys are resolved via memory vault-resolve
 * only (secrets never stored on the edge).
 */

import { createHash } from "node:crypto";
import type { AppBackendRunResult } from "../../../core/types/appBackend.js";
import { sanitizeError } from "../../../core/tools/security.js";
import {
  filterVaultKeyNames,
  PAPR_GATEWAY_URL_ENV,
} from "../../../core/utils/platformInjectedEnvKeys.js";
import {
  loadBackendHandlerContent,
  loadBackendRevisionArtifacts,
} from "./backendArtifactCache.js";
import {
  buildBackendActionEnv,
  resolveActionTimeoutMs,
  runBackendHandler,
  type MiniAppCallerIdentity,
} from "./appBackendRunner.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import {
  fetchRuntimeDbToken,
  resolveRuntimeVaultEnv,
  type RuntimeVaultResolveResult,
} from "./memoryRuntimeClient.js";
import type { AppAccessContext, AppRuntimeRouteAuth } from "./types.js";
import { assertActionAclAllowed } from "./actionAcl.js";
import {
  collectBackendDatabaseSecrets,
  resolveCloudAppBackendDatabaseEnv,
} from "./appBackendDatabase.js";
import {
  mintBackendDbProxyEnv,
  revokeBackendDbProxyToken,
} from "./backendDbProxy.js";
import { parseDataSourcesFile, type AppDataSourcesFile } from "../appDataSources.js";
import { hydrateCloudDatabaseRegistry } from "./cloudDatabaseRegistry.js";

const CLOUD_APP_HOST_PORT = Number(
  process.env.PORT ?? process.env.CLOUD_APP_HOST_PORT ?? 8787,
);

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Actions that declare `effect: "write"` or `"external"` change data or reach
 * outside Papr — refuse them up front for callers without write access (same
 * rule as /api/db/write). Undeclared actions are still safe: every DB write
 * they make goes through the backend DB proxy, which enforces canWrite.
 */
export function assertActionEffectAllowed(
  actionName: string,
  effect: string | undefined,
  access: { canWrite: boolean } | undefined,
): void {
  if (!access || access.canWrite) return;
  if (effect === "write" || effect === "external") {
    throw Object.assign(
      new Error(
        `Action "${actionName}" ${effect === "write" ? "changes data" : "acts outside Papr"}; ` +
          "this link is read-only.",
      ),
      { status: 403 },
    );
  }
}

/**
 * Read-only callers get the backend DB proxy only (it enforces canWrite).
 * Direct Turso URL/token pairs would let a handler write around it — the
 * memory-minted token is not read-only today.
 */
export function stripDirectDbCredentials(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "PAPR_DB_URL" || key === "PAPR_DB_AUTH_TOKEN") continue;
    if (key.startsWith("PAPR_DB_") && (key.endsWith("_URL") || key.endsWith("_AUTH_TOKEN"))) continue;
    if (key === "PAPR_DB_MODE" && value === "turso") continue;
    if (key.startsWith("PAPR_DB_") && key.endsWith("_MODE") && value === "turso") continue;
    out[key] = value;
  }
  return out;
}

export class CloudAppBackendService {
  async runAction(
    auth: AppRuntimeRouteAuth,
    input: {
      appId: string;
      action: string;
      params?: Record<string, string>;
      timeoutMs?: number;
      bypassFresh?: boolean;
      callerIdentity?: MiniAppCallerIdentity;
      loggedIn?: boolean;
      /** Preloaded by schema gate — skips duplicate repo fetches + registry hydrate. */
      dataSources?: AppDataSourcesFile;
      /** Preloaded in parallel with data-sources — skips manifest repo fetch. */
      manifestContent?: string;
      cloudAccess?: {
        orgId: string;
        namespaceId: string;
        userId: string;
        canRead: boolean;
        canWrite: boolean;
        /** Access mode (team / people / link …) for `members` action ACLs. */
        mode?: AppAccessContext["mode"];
      };
    },
  ): Promise<AppBackendRunResult & { action: string }> {
    const actionName = input.action.trim();
    const cacheOpts = input.bypassFresh ? { bypassFresh: true } : undefined;

    const artifacts = await loadBackendRevisionArtifacts(auth, cacheOpts);
    const manifest = artifacts.manifest;
    const spec = manifest.actions[actionName];
    if (!spec) {
      throw new Error(`Unknown backend action: ${actionName}`);
    }
    assertActionEffectAllowed(actionName, spec.effect, input.cloudAccess);
    if (input.cloudAccess) {
      assertActionAclAllowed(
        actionName,
        spec.acl,
        { mode: input.cloudAccess.mode ?? "link_read", userId: input.cloudAccess.userId },
        input.loggedIn ? input.callerIdentity?.userId : undefined,
      );
    }

    const handlerPath = `backend/${spec.handler}`;
    const vaultKeyNames = filterVaultKeyNames(spec.keys ?? []);
    const preloadedDataSources = input.dataSources;

    const [handlerContent, dsFile, vaultResult] = await Promise.all([
      loadBackendHandlerContent(auth, handlerPath, artifacts, cacheOpts),
      preloadedDataSources
        ? Promise.resolve(null)
        : fetchCachedRuntimeRepoFile(auth, "data-sources.json", cacheOpts),
      vaultKeyNames.length > 0
        ? resolveRuntimeVaultEnv(auth, { keyNames: vaultKeyNames })
        : Promise.resolve({ env: {}, missing: [] } satisfies RuntimeVaultResolveResult),
    ]);

    if (artifacts.bundle) {
      const expected = artifacts.bundle.actions?.[actionName];
      if (expected) {
        const actualHash = sha256(handlerContent);
        if (actualHash !== expected.sha256) {
          throw new Error(
            `Backend handler hash mismatch for ${actionName}. ` +
              "The synced handler differs from backend/bundle.json — run Sync now in Paprwork " +
              "(rebuilds bundle.json) or republish the app.",
          );
        }
      }
    }

    const { env: vaultEnv, missing } = vaultResult;
    if (vaultKeyNames.length && missing.length > 0) {
      throw new Error(
        `Missing vault keys for action ${actionName}: ${missing.join(", ")}. ` +
          "Ensure the key exists in Settings → Integration Keys, is declared in backend/manifest.json " +
          `"keys", and appears in requirements.json (cloud catalog). Republish the app after updating requirements.`,
      );
    }

    const timeoutMs = resolveActionTimeoutMs(spec, input.timeoutMs);

    const dataSources =
      preloadedDataSources ??
      (dsFile?.content
        ? parseDataSourcesFile(dsFile.content)
        : { sources: [] });
    if (!preloadedDataSources) {
      await hydrateCloudDatabaseRegistry(auth, dataSources);
    }
    const sourceId = input.params?.sourceId ?? spec.sourceId;
    const databaseEnv = await resolveCloudAppBackendDatabaseEnv({
      appId: input.appId,
      config: dataSources,
      fetchTursoToken: (database) => fetchRuntimeDbToken(auth, database),
      sourceId,
    });
    const proxyEnv = mintBackendDbProxyEnv({
      appId: input.appId,
      sourceId,
      proxyBaseUrl: `http://127.0.0.1:${CLOUD_APP_HOST_PORT}`,
      cloud: input.cloudAccess
        ? {
            runtimeAuth: auth,
            orgId: input.cloudAccess.orgId,
            namespaceId: input.cloudAccess.namespaceId,
            userId: input.cloudAccess.userId,
            callerUserId: input.callerIdentity?.userId,
            canRead: input.cloudAccess.canRead,
            canWrite: input.cloudAccess.canWrite,
          }
        : undefined,
    });

    const runEnv = buildBackendActionEnv({
      appId: input.appId,
      action: actionName,
      params: input.params,
      vaultEnv,
      databaseEnv: {
        ...(input.cloudAccess && !input.cloudAccess.canWrite
          ? stripDirectDbCredentials(databaseEnv)
          : databaseEnv),
        ...proxyEnv,
      },
      callerIdentity: input.callerIdentity,
      loggedIn: input.loggedIn,
    });
    runEnv[PAPR_GATEWAY_URL_ENV] =
      `http://127.0.0.1:${CLOUD_APP_HOST_PORT}`;

    try {
      const result = await runBackendHandler({
        spec,
        handlerSource: handlerContent,
        env: runEnv,
        timeoutMs,
      });

      const secretValues = [
        ...Object.values(vaultEnv).filter((v) => v.length > 0),
        ...collectBackendDatabaseSecrets(databaseEnv),
      ];
      return {
        action: actionName,
        stdout: sanitizeError(result.stdout, secretValues),
        stderr: sanitizeError(result.stderr, secretValues),
        exitCode: result.exitCode,
      };
    } finally {
      revokeBackendDbProxyToken(proxyEnv.PAPR_DB_PROXY_TOKEN);
    }
  }
}
