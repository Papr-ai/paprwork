/**
 * validate_app: run each backend action once against the app's real database.
 *
 * The preview only exercises actions the first screen calls. A handler with a
 * DB bug (wrong row shape, unsupported SQL, a crash) in any other action passed
 * validation and broke for the user later. This calls every action the preview
 * did not, with no params, through the same runtime path users hit.
 *
 * Safe by construction:
 *  - the DB proxy session is read-only — every write is rejected, so no rows change
 *  - actions that declare vault keys are skipped (they may send email/SMS, spend money)
 *  - actions whose input schema has required fields are skipped (no sensible call)
 * A rejected write means the action reached its write path: not a failure.
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { AppBackendActionSpec } from "../../core/types/appBackend.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { findRowArrays, isKeyEcho } from "./previewLoadedData.js";

const MAX_ACTIONS = 8;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_WRITE_MARKER = "writes are blocked during the check";

export interface BackendProbeResult {
  errors: string[];
  probed: string[];
  skipped: Array<{ action: string; reason: string }>;
}

function skipReason(spec: AppBackendActionSpec): string | null {
  if (spec.keys?.length) return "uses vault keys (may call external services)";
  if (spec.input?.required?.length) return "requires input";
  return null;
}

function lastErrorLine(stderr: string): string {
  const lines = stderr.trim().split("\n").filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

export async function probeBackendActions(
  appId: string,
  alreadyCalled: ReadonlySet<string>,
): Promise<BackendProbeResult> {
  const out: BackendProbeResult = { errors: [], probed: [], skipped: [] };
  const { parseAppBackendManifest, backendManifestRelativePath } = await import(
    "../services/appRuntime/appBackendManifest.js"
  );
  let raw: string;
  try {
    raw = await fs.readFile(path.join(getPaprRoot(), backendManifestRelativePath(appId)), "utf8");
  } catch {
    return out; // no backend
  }
  let actions: Record<string, AppBackendActionSpec>;
  try {
    actions = parseAppBackendManifest(JSON.parse(raw)).actions;
  } catch (err) {
    out.errors.push(`[backend] manifest.json is invalid: ${(err as Error).message}`);
    return out;
  }

  const targets: string[] = [];
  for (const [name, spec] of Object.entries(actions)) {
    if (name === "ping" || alreadyCalled.has(name)) continue;
    const reason = skipReason(spec);
    if (reason) out.skipped.push({ action: name, reason });
    else targets.push(name);
  }

  const { AppBackendService } = await import("../services/appRuntime/AppBackendService.js");
  const service = new AppBackendService();
  await Promise.all(
    targets.slice(0, MAX_ACTIONS).map(async (action) => {
      out.probed.push(action);
      try {
        const r = await service.runAction({ appId, action, params: {}, probe: true, timeoutMs: PROBE_TIMEOUT_MS });
        if (r.exitCode !== 0) {
          if (`${r.stderr}${r.stdout}`.includes(PROBE_WRITE_MARKER)) return;
          out.errors.push(`[backend] action "${action}" failed (exit ${r.exitCode}): ${lastErrorLine(r.stderr) || "no output"}`);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop() ?? "");
        } catch {
          return; // non-JSON output is the handler's choice
        }
        const echo = findRowArrays(parsed).flat().find(isKeyEcho);
        if (echo) {
          out.errors.push(
            `[backend] action "${action}" returns rows whose values are their column names, e.g. ` +
              `${JSON.stringify(echo).slice(0, 160)} — use query(con, sql).rows (plain dicts).`,
          );
        }
      } catch (err) {
        out.errors.push(`[backend] action "${action}" could not run: ${(err as Error).message}`);
      }
    }),
  );
  return out;
}
