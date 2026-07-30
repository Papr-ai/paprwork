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
} from "./appBackendRunner.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { resolveDesktopAppBackendDatabaseEnv } from "./appBackendDatabase.js";

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
  }): Promise<AppBackendRunResult> {
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
    const env = buildBackendActionEnv({
      appId: input.appId,
      action: input.action,
      params: input.params,
      vaultEnv: input.vaultEnv,
      databaseEnv,
      paprRoot: this.paprRoot,
    });

    return runBackendHandler({
      spec,
      handlerPath,
      env,
      timeoutMs,
    });
  }
}
