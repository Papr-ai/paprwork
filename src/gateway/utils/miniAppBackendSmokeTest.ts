/**
 * Smoke-test one backend action during validate_app (ping preferred).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { ValidationIssue } from "../services/AppService.js";
import { parseAppBackendManifest } from "../services/appRuntime/appBackendManifest.js";
import { AppBackendService } from "../services/appRuntime/AppBackendService.js";
import { BACKEND_FOLDER } from "./appBackendScaffold.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";

function pickSmokeAction(actionNames: readonly string[]): string | null {
  if (actionNames.length === 0) {
    return null;
  }
  if (actionNames.includes("ping")) {
    return "ping";
  }
  return [...actionNames].sort()[0] ?? null;
}

function truncateStderr(stderr: string, maxLen = 280): string {
  const oneLine = stderr.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLen)}…`;
}

/**
 * Run ping (or first manifest action) with empty params.
 * Skips when backend/manifest.json is missing.
 */
export async function checkBackendActionSmokeTest(
  appId: string,
): Promise<ValidationIssue[]> {
  const paprRoot = getPaprRoot();
  const appPath = path.join(paprRoot, "apps", appId);
  const manifestPath = path.join(appPath, BACKEND_FOLDER, "manifest.json");

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return [];
  }

  let action: string;
  try {
    const manifest = parseAppBackendManifest(JSON.parse(manifestRaw) as unknown);
    const picked = pickSmokeAction(Object.keys(manifest.actions));
    if (!picked) {
      return [];
    }
    action = picked;
  } catch (err) {
    return [
      {
        file: `${BACKEND_FOLDER}/manifest.json`,
        severity: "error",
        message: `Backend smoke test skipped — invalid manifest: ${(err as Error).message}`,
        rule: "backend-smoke-test",
      },
    ];
  }

  try {
    const service = new AppBackendService(paprRoot);
    const result = await service.runAction({
      appId,
      action,
      params: {},
    });

    if (result.exitCode === 0) {
      return [];
    }

    const detail = truncateStderr(result.stderr || result.stdout);
    return [
      {
        file: `${BACKEND_FOLDER}/manifest.json`,
        severity: "error",
        message:
          `Backend smoke test failed for action "${action}" (exit ${result.exitCode}). ` +
          (detail
            ? detail
            : "Handler exited non-zero — use PAPR_ACTION_PARAMS (not sys.stdin) and print JSON to stdout.") +
          (action !== "ping"
            ? ' Tip: scaffold a "ping" action for a DB-free smoke test.'
            : ""),
        rule: "backend-smoke-test",
      },
    ];
  } catch (err) {
    return [
      {
        file: `${BACKEND_FOLDER}/manifest.json`,
        severity: "error",
        message: `Backend smoke test could not run action "${action}": ${(err as Error).message}`,
        rule: "backend-smoke-test",
      },
    ];
  }
}
