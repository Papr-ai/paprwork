/**
 * Shared backend handler execution (desktop + Cloud App Host).
 */

import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import type { AppBackendActionSpec } from "../../../core/types/appBackend.js";
import type { AppBackendRunResult } from "../../../core/types/appBackend.js";
import {
  mergeVerifiedCallerJobParams,
  VERIFIED_CALLER_EMAIL_PARAM,
  VERIFIED_CALLER_USER_ID_PARAM,
  type MiniAppCallerIdentity,
} from "./miniAppAccess.js";

export type { MiniAppCallerIdentity };

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_BACKEND_TIMEOUT_MS = 600_000;

export function resolveActionTimeoutMs(
  spec: AppBackendActionSpec,
  overrideMs?: number,
): number {
  const base = overrideMs ?? spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(base, 1_000), MAX_BACKEND_TIMEOUT_MS);
}

export function buildBackendActionEnv(input: {
  appId: string;
  action: string;
  params?: Record<string, string>;
  vaultEnv?: Record<string, string>;
  databaseEnv?: Record<string, string>;
  paprRoot?: string;
  /** Server-resolved caller — injected when signed in; overrides client identity params. */
  callerIdentity?: MiniAppCallerIdentity;
  loggedIn?: boolean;
}): Record<string, string> {
  const mergedParams = mergeVerifiedCallerJobParams(
    input.params,
    input.loggedIn ?? false,
    input.callerIdentity,
  );

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(input.databaseEnv ?? {}),
    PAPR_APP_ID: input.appId,
    PAPR_ACTION: input.action,
    ...(input.paprRoot ? { PAPR_ROOT: input.paprRoot } : {}),
    ...(input.vaultEnv ?? {}),
  };
  if (mergedParams) {
    env.PAPR_ACTION_PARAMS = JSON.stringify(mergedParams);
    for (const [key, value] of Object.entries(mergedParams)) {
      env[`PAPR_PARAM_${key}`] = value;
    }
  }
  const callerUserId = input.callerIdentity?.userId?.trim();
  if (input.loggedIn && callerUserId) {
    env[VERIFIED_CALLER_USER_ID_PARAM] = callerUserId;
    const callerEmail = input.callerIdentity?.email?.trim();
    if (callerEmail) {
      env[VERIFIED_CALLER_EMAIL_PARAM] = callerEmail;
    }
  }
  return env;
}

function spawnWithTimeout(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<AppBackendRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Backend action timed out"));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

export function runPythonHandlerAtPath(
  handlerPath: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<AppBackendRunResult> {
  return spawnWithTimeout("python3", [handlerPath], env, timeoutMs);
}

export function runNodeHandlerAtPath(
  handlerPath: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<AppBackendRunResult> {
  return spawnWithTimeout("node", [handlerPath], env, timeoutMs);
}

async function transpileBackendTypeScript(
  source: string,
  filename: string,
): Promise<string> {
  const esbuild = await import("esbuild");
  const ext = path.extname(filename).toLowerCase();
  const result = await esbuild.transform(source, {
    loader: ext === ".tsx" ? "tsx" : "ts",
    format: "esm",
    target: "es2022",
    platform: "node",
  });
  return result.code;
}

async function runTypeScriptHandlerSource(
  handlerSource: string,
  handlerFilename: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<AppBackendRunResult> {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-backend-"));
  const handlerPath = path.join(tmpdir, "handler.mjs");
  try {
    const code = await transpileBackendTypeScript(handlerSource, handlerFilename);
    await fs.writeFile(handlerPath, code, "utf8");
    return await runNodeHandlerAtPath(handlerPath, env, timeoutMs);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

let cachedBackendDbHelperPy: string | null = null;

async function loadBackendDbHelperPy(): Promise<string> {
  if (cachedBackendDbHelperPy) {
    return cachedBackendDbHelperPy;
  }
  const helperPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "backendDbHelper.py",
  );
  cachedBackendDbHelperPy = await fs.readFile(helperPath, "utf8");
  return cachedBackendDbHelperPy;
}

export async function runPythonHandlerFromSource(
  handlerSource: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<AppBackendRunResult> {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-backend-"));
  const handlerPath = path.join(tmpdir, "handler.py");
  try {
    await fs.writeFile(handlerPath, handlerSource, "utf8");
    await fs.writeFile(
      path.join(tmpdir, "papr_db.py"),
      await loadBackendDbHelperPy(),
      "utf8",
    );
    return await runPythonHandlerAtPath(handlerPath, env, timeoutMs);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runBackendHandler(input: {
  spec: AppBackendActionSpec;
  handlerPath?: string;
  handlerSource?: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<AppBackendRunResult> {
  const { spec, env, timeoutMs } = input;

  if (spec.runtime === "python") {
    if (input.handlerPath) {
      return runPythonHandlerAtPath(input.handlerPath, env, timeoutMs);
    }
    if (input.handlerSource !== undefined) {
      return runPythonHandlerFromSource(input.handlerSource, env, timeoutMs);
    }
    throw new Error("Backend handler path or source required");
  }

  if (spec.runtime === "node") {
    if (input.handlerPath) {
      return runNodeHandlerAtPath(input.handlerPath, env, timeoutMs);
    }
    if (input.handlerSource !== undefined) {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-backend-"));
      const ext = path.extname(spec.handler).toLowerCase() || ".mjs";
      const handlerPath = path.join(tmpdir, `handler${ext}`);
      try {
        await fs.writeFile(handlerPath, input.handlerSource, "utf8");
        return await runNodeHandlerAtPath(handlerPath, env, timeoutMs);
      } finally {
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw new Error("Backend handler path or source required");
  }

  if (spec.runtime === "typescript") {
    const source = input.handlerSource;
    if (source !== undefined) {
      return runTypeScriptHandlerSource(source, spec.handler, env, timeoutMs);
    }
    if (input.handlerPath) {
      const fileSource = await fs.readFile(input.handlerPath, "utf8");
      return runTypeScriptHandlerSource(fileSource, spec.handler, env, timeoutMs);
    }
    throw new Error("Backend handler path or source required");
  }

  throw new Error(`Unsupported backend runtime: ${spec.runtime}`);
}
