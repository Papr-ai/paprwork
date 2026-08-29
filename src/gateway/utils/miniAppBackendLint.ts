/**
 * Lint mini-apps for deprecated bash usage and backend manifest integrity.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { ValidationIssue } from "../services/AppService.js";
import type { RequiredKeySpec } from "../../core/types/bundles.js";
import type { AppBackendManifest } from "../../core/types/appBackend.js";
import {
  isPlatformInjectedEnvKey,
  VERIFIED_CALLER_EMAIL_ENV,
  VERIFIED_CALLER_USER_ID_ENV,
} from "../../core/utils/platformInjectedEnvKeys.js";
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
  "PAPR_BACKEND_PARAMS",
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
  "PAPR_DB_PROXY_URL",
  "PAPR_DB_PROXY_TOKEN",
  "PAPR_ACTIVE_SOURCE_ID",
  "PAPR_LINKED_DB_ALIASES",
  VERIFIED_CALLER_USER_ID_ENV,
  VERIFIED_CALLER_EMAIL_ENV,
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

const BACKEND_STDIN_PATTERN = /\bsys\.stdin\b|json\.load\s*\(\s*sys\.stdin\s*\)/;

const BACKEND_RAW_SQLITE3_PATTERN =
  /\bimport\s+sqlite3\b|(?:^|[^\w])sqlite3\.connect\s*\(/m;

const BACKEND_LASTROWID_PATTERN =
  /\b(?:cursor|cur)\.lastrowid\b|\.lastrowid\b(?!\s*=)/;

const BACKEND_FETCH_PATTERN =
  /fetch\s*\(\s*[`'"]\/api\/app\/backend\/[^`'"]+[`'"]/g;

/** Literal object passed to JSON.stringify in a backend fetch (single-level). */
const BACKEND_FETCH_BODY_LITERAL =
  /JSON\.stringify\s*\(\s*(\{[^{}]*\})\s*\)/;

function stripLineCommentsForLint(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("#")
      ) {
        return "";
      }
      const slash = line.indexOf("//");
      return slash >= 0 ? line.slice(0, slash) : line;
    })
    .join("\n");
}

export function checkBackendHandlerPatterns(
  handlerRelativePath: string,
  handlerSource: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const file = `${BACKEND_FOLDER}/${handlerRelativePath}`;

  if (BACKEND_STDIN_PATTERN.test(handlerSource)) {
    issues.push({
      file,
      severity: "error",
      message:
        "Backend handlers cannot read sys.stdin — the gateway injects params via PAPR_ACTION_PARAMS. " +
        'Use: params = json.loads(os.environ.get("PAPR_ACTION_PARAMS", "{}")) (Python) or ' +
        'JSON.parse(process.env.PAPR_ACTION_PARAMS ?? "{}") (Node/TS).',
      rule: "backend-no-stdin",
    });
  }

  if (/\bAPP_DB_PATH\b/.test(handlerSource)) {
    issues.push({
      file,
      severity: "error",
      message:
        'APP_DB_PATH is not a platform env var. Use from papr_db import connect; con = connect("alias") ' +
        "(or connect() for the active linked DB). See backend/papr_db.py scaffold.",
      rule: "backend-no-app-db-path",
    });
  }

  if (BACKEND_RAW_SQLITE3_PATTERN.test(handlerSource)) {
    issues.push({
      file,
      severity: "error",
      message:
        "Do not import sqlite3 or call sqlite3.connect() in backend handlers — cloud runs with " +
        "PAPR_DB_MODE=turso (no local APP_DB file). Use from papr_db import connect; con = connect() " +
        'or connect("alias").',
      rule: "backend-no-raw-sqlite3",
    });
  }

  if (BACKEND_LASTROWID_PATTERN.test(handlerSource)) {
    issues.push({
      file,
      severity: "warning",
      message:
        "Avoid cursor.lastrowid in backend handlers — use write(con, sql, params).last_insert_rowid " +
        "or INSERT … RETURNING with query(). Cloud and desktop both route through the Papr DB contract.",
      rule: "backend-no-lastrowid",
    });
  }

  return issues;
}

/**
 * Warn when frontend fetch('/api/app/backend/...') sends a literal body without params:.
 * Skips JSON.stringify(variable) — cannot analyze runtime shapes safely.
 */
export function checkMiniAppBackendFetchPatterns(
  fileContents: Map<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [filename, content] of fileContents.entries()) {
    if (!isFrontendSource(filename)) {
      continue;
    }

    const code = stripLineCommentsForLint(content);
    BACKEND_FETCH_PATTERN.lastIndex = 0;

    for (const match of code.matchAll(BACKEND_FETCH_PATTERN)) {
      const start = match.index ?? 0;
      const slice = code.slice(start, start + 900);
      const bodyMatch = BACKEND_FETCH_BODY_LITERAL.exec(slice);
      if (!bodyMatch) {
        continue;
      }
      const literal = bodyMatch[1] ?? "";
      if (/\bparams\s*:/.test(literal)) {
        continue;
      }

      issues.push({
        file: filename,
        severity: "warning",
        message:
          "POST /api/app/backend/:action expects { params: { ... } } in the JSON body " +
          "(gateway maps params → PAPR_ACTION_PARAMS). Wrap handler args: " +
          'JSON.stringify({ params: { key: value } }). Parse the response: ' +
          "const { stdout, exitCode, stderr } = await res.json(); JSON.parse(stdout).",
        rule: "backend-fetch-params-wrapper",
      });
      break;
    }
  }

  return issues;
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

/** Strip comments so scaffold examples do not trigger vault-key lint. */
export function stripCommentsForVaultEnvScan(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        return "";
      }
      const hashIdx = line.indexOf("#");
      if (hashIdx !== -1) {
        return line.slice(0, hashIdx);
      }
      const slashIdx = line.indexOf("//");
      if (slashIdx !== -1) {
        return line.slice(0, slashIdx);
      }
      return line;
    })
    .join("\n");
}

export function extractVaultEnvReferences(handlerSource: string): Set<string> {
  const names = new Set<string>();
  const scanSource = stripCommentsForVaultEnvScan(handlerSource);
  for (const pattern of ENV_VAR_REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of scanSource.matchAll(pattern)) {
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

function checkManifestPlatformInjectedKeys(
  manifest: AppBackendManifest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [actionName, spec] of Object.entries(manifest.actions)) {
    for (const key of spec.keys ?? []) {
      if (!isPlatformInjectedEnvKey(key)) {
        continue;
      }
      issues.push({
        file: `${BACKEND_FOLDER}/manifest.json`,
        severity: "warning",
        message:
          `Action "${actionName}" lists "${key.trim()}" in "keys", but ${key.trim()} is ` +
          "server-injected when the caller is signed in — not a Settings vault key. " +
          'Remove it from "keys"; handlers read os.environ / process.env directly.',
        rule: "backend-keys-platform-injected",
      });
    }
  }
  return issues;
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
    issues.push(...checkManifestPlatformInjectedKeys(manifest));
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
          ...checkBackendHandlerPatterns(spec.handler, handlerSource),
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

const ORPHAN_BACKEND_HANDLER_HINTS: Readonly<Record<string, string>> = {
  "migrate.py":
    'Add a "migrate" action to backend/manifest.json and call POST /api/app/backend/migrate after linking the DB, or use POST /api/db/exec with CREATE TABLE IF NOT EXISTS.',
  "schema.py":
    "Register schema bootstrap in backend/manifest.json or use POST /api/db/exec from the mini-app.",
};

/**
 * Flag backend/*.py files that exist on disk but are not registered in manifest.json.
 */
export async function checkOrphanBackendHandlers(
  appPath: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const backendDir = path.join(appPath, BACKEND_FOLDER);
  const manifestPath = path.join(backendDir, "manifest.json");

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return issues;
  }

  let registeredHandlers: Set<string>;
  try {
    const manifest = parseAppBackendManifest(JSON.parse(manifestRaw) as unknown);
    registeredHandlers = new Set(
      Object.values(manifest.actions).map((spec) =>
        spec.handler.replace(/\\/g, "/"),
      ),
    );
  } catch {
    return issues;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(backendDir);
  } catch {
    return issues;
  }

  /** Shared DB helpers copied by scaffold — not HTTP action handlers. */
  const backendHelperModules = new Set(["papr_db.py", "db_helper.py"]);

  for (const entry of entries) {
    if (!entry.endsWith(".py") || entry.startsWith("__")) {
      continue;
    }
    if (backendHelperModules.has(entry)) {
      continue;
    }
    const normalized = entry.replace(/\\/g, "/");
    if (registeredHandlers.has(normalized)) {
      continue;
    }
    const hint = ORPHAN_BACKEND_HANDLER_HINTS[entry] ?? "";
    issues.push({
      file: `${BACKEND_FOLDER}/${entry}`,
      severity: "error",
      message:
        `Backend handler "${entry}" exists but is not registered in backend/manifest.json — it will never run via /api/app/backend/:action.` +
        (hint ? ` ${hint}` : ""),
      rule: "backend-handler-orphan",
    });
  }

  return issues;
}
