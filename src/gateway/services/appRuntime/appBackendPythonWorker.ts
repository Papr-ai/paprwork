/**
 * Persistent Python worker for Cloud App Host backend actions.
 *
 * Avoids spawning a new python3 process from Node on every backend invoke
 * (saves ~500ms–2s cold-start per action on Cloud Run).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AppBackendRunResult } from "../../../core/types/appBackend.js";

const WORKER_BOOT_TIMEOUT_MS = 30_000;

interface WorkerRequest {
  id: string;
  handlerSource: string;
  dbHelperSource: string;
  env: Record<string, string>;
  timeoutMs: number;
}

interface WorkerSuccessResponse {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface WorkerErrorResponse {
  id: string;
  error: string;
}

type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

const PYTHON_WORKER_SCRIPT = String.raw`import json
import os
import shutil
import subprocess
import sys
import tempfile

def run_request(req):
    tmpdir = tempfile.mkdtemp(prefix="papr-backend-")
    try:
        handler_path = os.path.join(tmpdir, "handler.py")
        helper_path = os.path.join(tmpdir, "papr_db.py")
        with open(handler_path, "w", encoding="utf-8") as f:
            f.write(req["handlerSource"])
        with open(helper_path, "w", encoding="utf-8") as f:
            f.write(req["dbHelperSource"])
        env = {**os.environ, **{str(k): str(v) for k, v in req.get("env", {}).items()}}
        timeout_sec = max(1.0, float(req.get("timeoutMs", 30000)) / 1000.0)
        proc = subprocess.run(
            [sys.executable, handler_path],
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout_sec,
        )
        return {
            "id": req["id"],
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "exitCode": proc.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"id": req["id"], "error": "Backend action timed out"}
    except Exception as exc:
        return {"id": req["id"], "error": str(exc)}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except json.JSONDecodeError as exc:
        print(json.dumps({"id": None, "error": f"Invalid JSON request: {exc}"}), flush=True)
        continue
    print(json.dumps(run_request(req)), flush=True)
`;

let workerProcess: ChildProcess | null = null;
let workerReady: Promise<void> | null = null;
let bootResolver: (() => void) | null = null;
let bootRejecter: ((error: Error) => void) | null = null;
let stdoutBuffer = "";
let workerFailed = false;

const pendingRequests = new Map<
  string,
  {
    resolve: (result: AppBackendRunResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

export function isBackendPythonWorkerEnabled(): boolean {
  if (process.env.CLOUD_APP_HOST_PYTHON_WORKER === "0") {
    return false;
  }
  if (process.env.CLOUD_APP_HOST_PYTHON_WORKER === "1") {
    return true;
  }
  return process.env.NODE_ENV === "production";
}

function rejectAllPending(error: Error): void {
  for (const [id, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timer);
    pending.reject(error);
    pendingRequests.delete(id);
  }
}

function handleWorkerExit(): void {
  workerProcess = null;
  workerReady = null;
  stdoutBuffer = "";
  if (!workerFailed) {
    rejectAllPending(new Error("Backend Python worker exited unexpectedly"));
  }
}

function dispatchWorkerLine(line: string): void {
  let parsed: WorkerResponse & { ready?: boolean };
  try {
    parsed = JSON.parse(line) as WorkerResponse & { ready?: boolean };
  } catch {
    return;
  }
  if (parsed.ready === true) {
    bootResolver?.();
    bootResolver = null;
    bootRejecter = null;
    return;
  }
  if (!parsed.id) {
    return;
  }
  const pending = pendingRequests.get(parsed.id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingRequests.delete(parsed.id);
  if ("error" in parsed && typeof parsed.error === "string") {
    pending.reject(new Error(parsed.error));
    return;
  }
  const success = parsed as WorkerSuccessResponse;
  pending.resolve({
    stdout: success.stdout ?? "",
    stderr: success.stderr ?? "",
    exitCode: success.exitCode ?? 1,
  });
}

function onWorkerStdout(chunk: Buffer): void {
  stdoutBuffer += chunk.toString("utf8");
  let newlineIndex = stdoutBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      dispatchWorkerLine(line);
    }
    newlineIndex = stdoutBuffer.indexOf("\n");
  }
}

async function ensureWorkerReady(): Promise<void> {
  if (workerReady) {
    return workerReady;
  }

  workerReady = new Promise<void>((resolve, reject) => {
    bootResolver = resolve;
    bootRejecter = reject;

    const proc = spawn("python3", ["-u", "-c", PYTHON_WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    workerProcess = proc;
    workerFailed = false;

    const bootTimer = setTimeout(() => {
      workerFailed = true;
      proc.kill("SIGTERM");
      bootRejecter?.(new Error("Backend Python worker boot timed out"));
      bootRejecter = null;
      bootResolver = null;
    }, WORKER_BOOT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      onWorkerStdout(chunk);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text.trim().length > 0) {
        console.warn("[BackendPythonWorker]", text.trim().slice(0, 200));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(bootTimer);
      workerFailed = true;
      bootRejecter?.(err);
      bootRejecter = null;
      bootResolver = null;
    });

    proc.on("close", () => {
      clearTimeout(bootTimer);
      handleWorkerExit();
    });

    const originalResolve = bootResolver;
    bootResolver = () => {
      clearTimeout(bootTimer);
      originalResolve();
    };
  }).catch((err) => {
    workerReady = null;
    bootResolver = null;
    bootRejecter = null;
    throw err;
  });

  return workerReady;
}

export async function runPythonHandlerViaWorker(input: {
  handlerSource: string;
  dbHelperSource: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<AppBackendRunResult> {
  await ensureWorkerReady();
  if (!workerProcess?.stdin?.writable) {
    throw new Error("Backend Python worker is not writable");
  }

  const id = randomUUID();
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    stringEnv[key] = String(value);
  }
  const request: WorkerRequest = {
    id,
    handlerSource: input.handlerSource,
    dbHelperSource: input.dbHelperSource,
    env: stringEnv,
    timeoutMs: input.timeoutMs,
  };

  return new Promise<AppBackendRunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Backend action timed out"));
    }, input.timeoutMs + 2_000);

    pendingRequests.set(id, {
      resolve,
      reject,
      timer,
    });

    try {
      workerProcess?.stdin?.write(`${JSON.stringify(request)}\n`);
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function shutdownBackendPythonWorker(): void {
  workerFailed = true;
  rejectAllPending(new Error("Backend Python worker shutting down"));
  if (workerProcess && !workerProcess.killed) {
    workerProcess.kill("SIGTERM");
  }
  workerProcess = null;
  workerReady = null;
  stdoutBuffer = "";
}

export function resetBackendPythonWorkerForTests(): void {
  shutdownBackendPythonWorker();
  workerFailed = false;
}
