/**
 * Parse and validate apps/{appId}/backend/manifest.json
 */

import * as path from "path";
import type {
  AppBackendActionSpec,
  AppBackendManifest,
  AppBackendRuntime,
} from "../../../core/types/appBackend.js";

const ALLOWED_RUNTIMES: ReadonlySet<AppBackendRuntime> = new Set([
  "python",
  "node",
  "typescript",
]);

const RUNTIME_HANDLER_EXTENSIONS: Record<
  AppBackendRuntime,
  ReadonlySet<string>
> = {
  python: new Set([".py"]),
  node: new Set([".js", ".mjs", ".cjs"]),
  typescript: new Set([".ts"]),
};

function validateHandlerExtension(
  actionName: string,
  runtime: AppBackendRuntime,
  handler: string,
): void {
  const ext = path.extname(handler).toLowerCase();
  const allowed = RUNTIME_HANDLER_EXTENSIONS[runtime];
  if (!allowed.has(ext)) {
    throw new Error(
      `backend manifest: actions.${actionName}.handler "${handler}" must use extension ${[...allowed].join(", ")} for runtime "${runtime}"`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseActionSpec(
  actionName: string,
  raw: unknown,
): AppBackendActionSpec {
  if (!isRecord(raw)) {
    throw new Error(`backend manifest: actions.${actionName} must be an object`);
  }
  const handler = raw.handler;
  if (typeof handler !== "string" || !handler.trim()) {
    throw new Error(`backend manifest: actions.${actionName}.handler is required`);
  }
  if (handler.includes("..") || handler.startsWith("/")) {
    throw new Error(`backend manifest: actions.${actionName}.handler must be a relative file name`);
  }
  const runtime = raw.runtime;
  if (
    runtime !== "python" &&
    runtime !== "node" &&
    runtime !== "typescript"
  ) {
    throw new Error(
      `backend manifest: actions.${actionName}.runtime must be one of: python, node, typescript`,
    );
  }
  if (!ALLOWED_RUNTIMES.has(runtime)) {
    throw new Error(`backend manifest: unsupported runtime ${String(runtime)}`);
  }
  validateHandlerExtension(actionName, runtime, handler.trim());
  const keys = raw.keys;
  let keyNames: string[] | undefined;
  if (keys !== undefined) {
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || !k.trim())) {
      throw new Error(`backend manifest: actions.${actionName}.keys must be string[]`);
    }
    keyNames = keys.map((k) => k.trim());
  }
  const timeoutMs = raw.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || timeoutMs < 1_000 || timeoutMs > 600_000)
  ) {
    throw new Error(
      `backend manifest: actions.${actionName}.timeoutMs must be 1000–600000`,
    );
  }
  const description =
    typeof raw.description === "string" ? raw.description : undefined;
  const sourceId =
    typeof raw.sourceId === "string" && raw.sourceId.trim()
      ? raw.sourceId.trim()
      : undefined;
  return {
    handler: handler.trim(),
    runtime,
    keys: keyNames,
    timeoutMs,
    description,
    sourceId,
  };
}

export function parseAppBackendManifest(raw: unknown): AppBackendManifest {
  if (!isRecord(raw)) {
    throw new Error("backend manifest: root must be an object");
  }
  if (raw.version !== 1) {
    throw new Error("backend manifest: version must be 1");
  }
  const actionsRaw = raw.actions;
  if (!isRecord(actionsRaw) || Object.keys(actionsRaw).length === 0) {
    throw new Error("backend manifest: actions must be a non-empty object");
  }
  const actions: Record<string, AppBackendActionSpec> = {};
  for (const [name, spec] of Object.entries(actionsRaw)) {
    if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
      throw new Error(
        `backend manifest: invalid action name "${name}" (use alphanumeric and hyphens)`,
      );
    }
    actions[name] = parseActionSpec(name, spec);
  }
  return { version: 1, actions };
}

/** All vault key names declared across backend actions (deduped). */
export function collectBackendManifestKeyNames(
  manifest: AppBackendManifest,
): string[] {
  const names = new Set<string>();
  for (const spec of Object.values(manifest.actions)) {
    for (const key of spec.keys ?? []) {
      const trimmed = key.trim();
      if (trimmed) {
        names.add(trimmed);
      }
    }
  }
  return [...names];
}

export function backendManifestRelativePath(appId: string): string {
  return `apps/${appId}/backend/manifest.json`;
}

export function backendHandlerRelativePath(
  appId: string,
  handlerFile: string,
): string {
  return `apps/${appId}/backend/${handlerFile}`;
}
