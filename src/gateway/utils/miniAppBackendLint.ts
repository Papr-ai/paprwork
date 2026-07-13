/**
 * Lint mini-apps for deprecated bash usage and backend manifest integrity.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { ValidationIssue } from "../services/AppService.js";
import type { RequiredKeySpec } from "../../core/types/bundles.js";
import {
  collectBackendManifestKeyNames,
  parseAppBackendManifest,
} from "../services/appRuntime/appBackendManifest.js";
import { BACKEND_FOLDER } from "./appBackendScaffold.js";

const BASH_RUN_PATTERN =
  /fetch\s*\(\s*['"`]\/api\/bash\/run|['"`]\/api\/bash\/run['"`]/;

const TMP_IPC_PATTERN =
  /\/api\/bash\/run[\s\S]{0,200}\/tmp\/|\/tmp\/[\s\S]{0,200}\/api\/bash\/run/;

/** Built-in backend env vars — not Settings vault keys. */
const IGNORED_BACKEND_ENV_NAMES = new Set([
  "PAPR_ACTION",
  "PAPR_ACTION_PARAMS",
  "PAPR_APP_ID",
  "PAPR_ROOT",
  "PAPR_HOME",
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TZ",
  "NODE_ENV",
  "PYTHONUNBUFFERED",
  "TERM",
  "SHELL",
  "PWD",
  "TMPDIR",
  "APP_ID",
  "APP_DB",
  "APP_DB_ALIAS",
  "APP_DB_JOB_ID",
  "PAPR_DB_MODE",
  "PAPR_DB_URL",
  "PAPR_DB_AUTH_TOKEN",
]);

const ENV_VAR_REFERENCE_PATTERNS: RegExp[] = [
  /os\.environ\.get\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /os\.getenv\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
];

function isFrontendSource(relativePath: string): boolean {
  if (relativePath.startsWith(`${BACKEND_FOLDER}/`) || relativePath.startsWith(`${BACKEND_FOLDER}\\`)) {
    return false;
  }
  return /\.(ts|tsx|js|jsx|html)$/.test(relativePath);
}

export function checkMiniAppBashPatterns(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [filename, content] of fileContents.entries()) {
    if (!isFrontendSource(filename)) {
      continue;
    }

    if (BASH_RUN_PATTERN.test(content)) {
      issues.push({
        file: filename,
        severity: "error",
        message:
          "Mini-apps cannot call /api/bash/run (disabled). Use POST /api/app/backend/:action for server handlers or POST /api/jobs/run for sandbox jobs.",
        rule: "no-mini-app-bash",
      });
    }

    if (TMP_IPC_PATTERN.test(content)) {
      issues.push({
        file: filename,
        severity: "error",
        message:
          "/tmp file handoffs via bash break on cloud (separate sandboxes). Use /api/jobs/run params + $APP_DB or /api/app/backend/:action.",
        rule: "no-tmp-bash-ipc",
      });
    }
  }

  return issues;
}

function extractVaultEnvReferences(handlerSource: string): Set<string> {
  const names = new Set<string>();
  for (const pattern of ENV_VAR_REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of handlerSource.matchAll(pattern)) {
      const name = match[1];
      if (
        !name ||
        IGNORED_BACKEND_ENV_NAMES.has(name) ||
        name.startsWith("PAPR_PARAM_")
      ) {
        continue;
      }
      names.add(name);
    }
  }
  return names;
}

function checkBackendVaultKeyDeclarations(
  actionName: string,
  handlerRelativePath: string,
  handlerSource: string,
  declaredKeys: readonly string[] | undefined,
): ValidationIssue[] {
  const referenced = extractVaultEnvReferences(handlerSource);
  if (referenced.size === 0) {
    return [];
  }

  const declared = new Set(
    (declaredKeys ?? []).map((key) => key.trim()).filter(Boolean),
  );
  const missing = [...referenced].filter((name) => !declared.has(name));
  if (missing.length === 0) {
    return [];
  }

  const missingList = missing.map((name) => `"${name}"`).join(", ");
  const keysJson = JSON.stringify(missing);
  return [
    {
      file: `${BACKEND_FOLDER}/${handlerRelativePath}`,
      severity: "warning",
      message:
        `Handler reads vault env ${missingList} but action "${actionName}" does not declare ` +
        `"keys": ${keysJson} in backend/manifest.json. Add the key names so the gateway injects ` +
        "Settings → Integration Keys (os.environ / process.env). Do not grep keychain or call get_key.",
      rule: "backend-vault-keys-undeclared",
    },
  ];
}

function checkBackendKeysInRequirements(
  backendKeyNames: readonly string[],
  requirements: RequiredKeySpec[],
): ValidationIssue[] {
  if (backendKeyNames.length === 0) {
    return [];
  }
  const declared = new Set(requirements.map((spec) => spec.name));
  const missing = backendKeyNames.filter((name) => !declared.has(name));
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      file: `${BACKEND_FOLDER}/manifest.json`,
      severity: "warning",
      message:
        `Backend declares keys ${missing.map((n) => `"${n}"`).join(", ")} but they are missing from ` +
        `requirements.json. Cloud vault-resolve requires both: manifest "keys" (per-action allowlist) ` +
        `AND requirements.json (published catalog). Run cloud publish to auto-sync, or add the keys to ` +
        `requirements.json with credentialScope: "owner" and clientAccess: "server".`,
      rule: "backend-keys-missing-from-requirements",
    },
  ];
}

export async function checkBackendManifestIntegrity(
  appPath: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const manifestPath = path.join(appPath, BACKEND_FOLDER, "manifest.json");

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return issues;
  }

  try {
    const manifest = parseAppBackendManifest(JSON.parse(manifestRaw) as unknown);
    const backendKeys = collectBackendManifestKeyNames(manifest);
    let requirementsFile: RequiredKeySpec[] = [];
    try {
      const reqRaw = await fs.readFile(
        path.join(appPath, "requirements.json"),
        "utf8",
      );
      const { parseRequirementsFileContent } = await import(
        "../services/cloudAppRequirements.js"
      );
      requirementsFile = parseRequirementsFileContent(reqRaw);
    } catch {
      requirementsFile = [];
    }
    issues.push(
      ...checkBackendKeysInRequirements(backendKeys, requirementsFile),
    );
    for (const [actionName, spec] of Object.entries(manifest.actions)) {
      const handlerPath = path.join(appPath, BACKEND_FOLDER, spec.handler);
      try {
        await fs.access(handlerPath);
        const handlerSource = await fs.readFile(handlerPath, "utf8");
        issues.push(
          ...checkBackendVaultKeyDeclarations(
            actionName,
            spec.handler,
            handlerSource,
            spec.keys,
          ),
        );
      } catch {
        issues.push({
          file: `${BACKEND_FOLDER}/manifest.json`,
          severity: "error",
          message: `Action "${actionName}" references missing handler: ${BACKEND_FOLDER}/${spec.handler}`,
          rule: "backend-handler-missing",
        });
      }
    }
  } catch (err) {
    issues.push({
      file: `${BACKEND_FOLDER}/manifest.json`,
      severity: "error",
      message: (err as Error).message,
      rule: "backend-manifest-invalid",
    });
  }

  return issues;
}
