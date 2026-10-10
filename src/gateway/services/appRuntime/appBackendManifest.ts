/**
 * Parse and validate apps/{appId}/backend/manifest.json
 */

import * as path from "path";
import type {
  AppBackendActionSpec,
  AppBackendInputField,
  AppBackendInputSchema,
  AppBackendManifest,
  AppBackendRuntime,
} from "../../../core/types/appBackend.js";
import { filterVaultKeyNames } from "../../../core/utils/platformInjectedEnvKeys.js";

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
  const input = raw.input === undefined ? undefined : parseInputSchema(actionName, raw.input);
  const effect = raw.effect;
  if (effect !== undefined && effect !== "read" && effect !== "write" && effect !== "external") {
    throw new Error(`backend manifest: actions.${actionName}.effect must be read, write or external`);
  }
  const runsOn = raw.runsOn;
  if (runsOn !== undefined && runsOn !== "cloud" && runsOn !== "mac") {
    throw new Error(`backend manifest: actions.${actionName}.runsOn must be cloud or mac`);
  }
  return {
    handler: handler.trim(),
    runtime,
    keys: keyNames,
    timeoutMs,
    description,
    sourceId,
    ...(input ? { input } : {}),
    ...(effect ? { effect } : {}),
    ...(runsOn ? { runsOn } : {}),
  };
}

const INPUT_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** Small JSON Schema subset: flat object of scalar fields. Keeps forms and tools predictable. */
export function parseInputSchema(actionName: string, raw: unknown): AppBackendInputSchema {
  const where = `backend manifest: actions.${actionName}.input`;
  if (!isRecord(raw) || raw.type !== "object" || !isRecord(raw.properties)) {
    throw new Error(`${where} must be { "type": "object", "properties": { … } }`);
  }
  const properties: AppBackendInputSchema["properties"] = {};
  for (const [key, field] of Object.entries(raw.properties)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`${where}: invalid field name "${key}"`);
    if (!isRecord(field) || typeof field.type !== "string" || !INPUT_TYPES.has(field.type)) {
      throw new Error(`${where}.properties.${key}.type must be string, number, integer or boolean`);
    }
    if (field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.some((v) => typeof v !== "string" && typeof v !== "number"))) {
      throw new Error(`${where}.properties.${key}.enum must be a list of strings or numbers`);
    }
    properties[key] = field as unknown as AppBackendInputField;
  }
  const required = raw.required;
  if (required !== undefined && (!Array.isArray(required) || required.some((r) => typeof r !== "string" || !(r in properties)))) {
    throw new Error(`${where}.required must list fields from properties`);
  }
  return { type: "object", properties, ...(required ? { required: required as string[] } : {}) };
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
  return filterVaultKeyNames([...names]);
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
