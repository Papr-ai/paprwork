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
import { filterVaultKeyNames } from "../../../core/utils/platformInjectedEnvKeys.js";
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
import type { AppRuntimeRouteAuth } from "./types.js";
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
      databaseEnv: { ...databaseEnv, ...proxyEnv },
      callerIdentity: input.callerIdentity,
      loggedIn: input.loggedIn,
    });

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
