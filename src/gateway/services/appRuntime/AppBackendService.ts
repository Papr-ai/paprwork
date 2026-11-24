/**
 * Local (desktop gateway) mini-app backend action executor.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { AppBackendRunResult } from "../../../core/types/appBackend.js";
import {
  backendHandlerRelativePath,
  backendManifestRelativePath,
  parseAppBackendManifest,
} from "./appBackendManifest.js";
import {
  buildBackendActionEnv,
  resolveActionTimeoutMs,
  runBackendHandler,
  type MiniAppCallerIdentity,
} from "./appBackendRunner.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { getAppRuntimeLogService } from "../AppRuntimeLogService.js";
import { recordPreviewBackendStdout } from "../../utils/previewLoadedData.js";
import { resolveDesktopAppBackendDatabaseEnv } from "./appBackendDatabase.js";
import {
  mintBackendDbProxyEnv,
  revokeBackendDbProxyToken,
} from "./backendDbProxy.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18789);

export class AppBackendService {
  private paprRoot: string;

  constructor(paprRoot?: string) {
    this.paprRoot = paprRoot ?? getPaprRoot();
  }

  async runAction(input: {
    appId: string;
    action: string;
    params?: Record<string, string>;
    vaultEnv?: Record<string, string>;
    callerIdentity?: MiniAppCallerIdentity;
    loggedIn?: boolean;
  }): Promise<AppBackendRunResult> {
    // Desktop: the signed-in Papr user runs their own install — same as the
    // local /api/access response (owner, full access).
    const manifestPath = path.join(
      this.paprRoot,
      backendManifestRelativePath(input.appId),
    );
    const manifestRaw = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as unknown;
    const manifest = parseAppBackendManifest(manifestRaw);
    const spec = manifest.actions[input.action];
    if (!spec) {
      throw new Error(`Unknown backend action: ${input.action}`);
    }

    const handlerPath = path.join(
      this.paprRoot,
      backendHandlerRelativePath(input.appId, spec.handler),
    );
    await fs.access(handlerPath);

    const timeoutMs = resolveActionTimeoutMs(spec);
    const sourceId = input.params?.sourceId ?? spec.sourceId;
    const databaseEnv = await resolveDesktopAppBackendDatabaseEnv({
      appId: input.appId,
      paprRoot: this.paprRoot,
      sourceId,
    });
    const proxyEnv = mintBackendDbProxyEnv({
      appId: input.appId,
      sourceId,
      proxyBaseUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
    });
    const env = buildBackendActionEnv({
      appId: input.appId,
      action: input.action,
      params: input.params,
      vaultEnv: input.vaultEnv,
      databaseEnv: { ...databaseEnv, ...proxyEnv },
      paprRoot: this.paprRoot,
      appDir: path.join(this.paprRoot, "apps", input.appId),
      callerIdentity: input.callerIdentity,
      callerAccess: { role: "admin", teamMember: true },
      loggedIn: input.loggedIn,
    });

    try {
      const result = await runBackendHandler({
        spec,
        handlerPath,
        env,
        timeoutMs,
      });
      recordBackendFailure(input.appId, input.action, result);
      if (result.exitCode === 0) recordPreviewBackendStdout(input.appId, input.action, result.stdout);
      return result;
    } finally {
      revokeBackendDbProxyToken(proxyEnv.PAPR_DB_PROXY_TOKEN);
    }
  }
}

/**
 * A failed backend action is a runtime error even though the HTTP call returns
 * 200 with exitCode in the body — apps often swallow it and render an empty
 * state. Logging it here (desktop and cloud share this path) puts it in the
 * buffer validate_app reads, so the preview fails instead of passing.
 */
function recordBackendFailure(
  appId: string,
  action: string,
  result: AppBackendRunResult,
): void {
  if (result.exitCode === 0) return;
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
  getAppRuntimeLogService().append(appId, {
    level: "error",
    message:
      `[backend] action "${action}" failed (exit ${result.exitCode}): ` +
      (detail.length > 300 ? `…${detail.slice(-300)}` : detail),
    source: `backend/${action}`,
    timestamp: new Date().toISOString(),
    origin: "preview",
  });
}
