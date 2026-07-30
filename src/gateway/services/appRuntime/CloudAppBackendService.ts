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
import { parseAppBackendManifest } from "./appBackendManifest.js";
import {
  buildBackendActionEnv,
  resolveActionTimeoutMs,
  runBackendHandler,
} from "./appBackendRunner.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import {
  fetchRuntimeDbToken,
  resolveRuntimeVaultEnv,
} from "./memoryRuntimeClient.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import {
  collectBackendDatabaseSecrets,
  resolveCloudAppBackendDatabaseEnv,
} from "./appBackendDatabase.js";
import { parseDataSourcesFile } from "../appDataSources.js";
import { hydrateCloudDatabaseRegistry } from "./cloudDatabaseRegistry.js";
import type { AppBackendBundleManifest } from "../../utils/miniAppBackendBuild.js";

const BACKEND_MANIFEST_PATH = "backend/manifest.json";
const BACKEND_BUNDLE_PATH = "backend/bundle.json";

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
    },
  ): Promise<AppBackendRunResult & { action: string }> {
    const actionName = input.action.trim();
    const cacheOpts = input.bypassFresh ? { bypassFresh: true } : undefined;

    const manifestFile = await fetchCachedRuntimeRepoFile(
      auth,
      BACKEND_MANIFEST_PATH,
      cacheOpts,
    );
    if (!manifestFile) {
      throw new Error(`Backend manifest not found for app ${input.appId}`);
    }

    const manifest = parseAppBackendManifest(
      JSON.parse(manifestFile.content) as unknown,
    );
    const spec = manifest.actions[actionName];
    if (!spec) {
      throw new Error(`Unknown backend action: ${actionName}`);
    }

    const handlerPath = `backend/${spec.handler}`;
    const handlerFile = await fetchCachedRuntimeRepoFile(
      auth,
      handlerPath,
      cacheOpts,
    );
    if (!handlerFile) {
      throw new Error(`Backend handler not found: ${handlerPath}`);
    }

    const bundleFile = await fetchCachedRuntimeRepoFile(
      auth,
      BACKEND_BUNDLE_PATH,
      cacheOpts,
    );
    if (bundleFile) {
      const bundle = JSON.parse(bundleFile.content) as AppBackendBundleManifest;
      const expected = bundle.actions?.[actionName];
      if (expected) {
        const actualHash = sha256(handlerFile.content);
        if (actualHash !== expected.sha256) {
          throw new Error(
            `Backend handler hash mismatch for ${actionName}. ` +
              "The synced handler differs from backend/bundle.json — run Sync now in Paprwork " +
              "(rebuilds bundle.json) or republish the app.",
          );
        }
      }
    }

    const { env: vaultEnv, missing } = await resolveRuntimeVaultEnv(auth, {
      keyNames: spec.keys,
    });
    if (spec.keys?.length && missing.length > 0) {
      throw new Error(
        `Missing vault keys for action ${actionName}: ${missing.join(", ")}. ` +
          "Ensure the key exists in Settings → Integration Keys, is declared in backend/manifest.json " +
          `"keys", and appears in requirements.json (cloud catalog). Republish the app after updating requirements.`,
      );
    }

    const timeoutMs = resolveActionTimeoutMs(spec, input.timeoutMs);

    const dsFile = await fetchCachedRuntimeRepoFile(
      auth,
      "data-sources.json",
      cacheOpts,
    );
    const dataSources = dsFile?.content
      ? parseDataSourcesFile(dsFile.content)
      : { sources: [] };
    await hydrateCloudDatabaseRegistry(auth, dataSources);
    const sourceId = input.params?.sourceId ?? spec.sourceId;
    const databaseEnv = await resolveCloudAppBackendDatabaseEnv({
      appId: input.appId,
      config: dataSources,
      fetchTursoToken: (database) => fetchRuntimeDbToken(auth, database),
      sourceId,
    });

    const runEnv = buildBackendActionEnv({
      appId: input.appId,
      action: actionName,
      params: input.params,
      vaultEnv,
      databaseEnv,
    });

    const result = await runBackendHandler({
      spec,
      handlerSource: handlerFile.content,
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
  }
}
