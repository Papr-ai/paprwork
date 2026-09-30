/**
 * Auto-sync vault key declarations in backend/manifest.json from handler source.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { parseAppBackendManifest } from "../services/appRuntime/appBackendManifest.js";
import { BACKEND_FOLDER } from "./appBackendScaffold.js";
import { extractVaultEnvReferences } from "./miniAppBackendLint.js";

export interface BackendManifestKeySyncResult {
  updated: boolean;
  addedKeys: string[];
  actionNames: string[];
}

const BACKEND_HANDLER_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
]);

function normalizeHandlerPath(handler: string): string {
  return handler.replace(/\\/g, "/");
}

function isBackendHandlerFile(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/");
  if (!normalized.startsWith(`${BACKEND_FOLDER}/`)) {
    return false;
  }
  const base = path.basename(normalized);
  if (base === "manifest.json" || base === "papr_db.py") {
    return false;
  }
  return BACKEND_HANDLER_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function mergeKeyNames(
  existing: readonly string[],
  referenced: readonly string[],
): { merged: string[]; added: string[] } {
  const seen = new Set(existing.map((key) => key.trim()).filter(Boolean));
  const added: string[] = [];
  for (const key of referenced) {
    if (!seen.has(key)) {
      seen.add(key);
      added.push(key);
    }
  }
  return {
    merged: [...seen].sort((a, b) => a.localeCompare(b)),
    added,
  };
}

/**
 * When a backend handler reads vault env vars, merge those names into the
 * matching manifest action's `keys` array (per-action allowlist for injection).
 */
export async function syncBackendManifestVaultKeys(
  appPath: string,
  handlerFilename: string,
  handlerSource: string,
): Promise<BackendManifestKeySyncResult> {
  const empty: BackendManifestKeySyncResult = {
    updated: false,
    addedKeys: [],
    actionNames: [],
  };
  if (!isBackendHandlerFile(handlerFilename)) {
    return empty;
  }

  const handlerRelative = normalizeHandlerPath(
    handlerFilename.slice(`${BACKEND_FOLDER}/`.length),
  );
  const referenced = extractVaultEnvReferences(handlerSource);
  if (referenced.size === 0) {
    return empty;
  }

  const manifestPath = path.join(appPath, BACKEND_FOLDER, "manifest.json");
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return empty;
  }

  const parsed = JSON.parse(manifestRaw) as Record<string, unknown>;
  let manifest;
  try {
    manifest = parseAppBackendManifest(parsed);
  } catch {
    return empty;
  }

  const matchingActions = Object.entries(manifest.actions)
    .filter(
      ([, spec]) => normalizeHandlerPath(spec.handler) === handlerRelative,
    )
    .map(([actionName]) => actionName);
  if (matchingActions.length === 0) {
    return empty;
  }

  const referencedKeys = [...referenced].sort((a, b) => a.localeCompare(b));
  const actionsRaw = parsed.actions as Record<string, Record<string, unknown>>;
  const addedKeys = new Set<string>();
  let updated = false;

  for (const actionName of matchingActions) {
    const actionRaw = actionsRaw[actionName];
    if (!actionRaw) {
      continue;
    }
    const existing = Array.isArray(actionRaw.keys)
      ? (actionRaw.keys as string[])
          .map((key) => key.trim())
          .filter(Boolean)
      : [];
    const { merged, added } = mergeKeyNames(existing, referencedKeys);
    if (added.length === 0) {
      continue;
    }
    actionRaw.keys = merged;
    for (const key of added) {
      addedKeys.add(key);
    }
    updated = true;
  }

  if (!updated) {
    return empty;
  }

  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    { flush: true },
  );

  return {
    updated: true,
    addedKeys: [...addedKeys].sort((a, b) => a.localeCompare(b)),
    actionNames: matchingActions,
  };
}
