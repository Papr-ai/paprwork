/**
 * Run Plan A Turso replica E2E scripts from Settings → Cloud Sync (dev builds only).
 */

import { app, ipcMain } from "electron";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export interface ReplicaE2eTestDefinition {
  id: string;
  name: string;
  npmScript: string;
  description: string;
  requiresAuth: boolean;
}

export interface ReplicaE2eRunResult {
  testId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  cancelled: boolean;
}

const REPLICA_E2E_TESTS: ReplicaE2eTestDefinition[] = [
  {
    id: "cutover-dry-run",
    name: "Cutover dry-run (linked legacy DBs)",
    npmScript: "cutover:replica:dry-run",
    description:
      "Classify linked legacy databases into cutover buckets — no mutations.",
    requiresAuth: true,
  },
  {
    id: "replica-production-e2e",
    name: "Replica production E2E",
    npmScript: "test:replica-production-e2e",
    description: "Live Turso write → pull → cloud verify (Plan A happy path).",
    requiresAuth: true,
  },
  {
    id: "replica-connect-flap",
    name: "Connect / disconnect flap (#5)",
    npmScript: "test:replica-connect-flap",
    description: "Rapid online/offline transitions — no duplicate rows or stuck state.",
    requiresAuth: true,
  },
  {
    id: "replica-cutover-e2e",
    name: "Cutover E2E (spikes 14–17)",
    npmScript: "test:replica-cutover-e2e",
    description:
      "Throwaway fixtures: seed local, pull remote, dirty merge, drift repair.",
    requiresAuth: true,
  },
  {
    id: "replica-extended",
    name: "Extended dogfood (migrations + offline)",
    npmScript: "test:replica-extended",
    description: "Spikes 11–13: migration no-git-gate, cloud-ahead, online DDL.",
    requiresAuth: true,
  },
];

let activeRun: {
  child: ChildProcess;
  testId: string;
  cancelled: boolean;
} | null = null;

function repoRootFromModule(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..");
}

function resolveRepoRoot(): string {
  if (!app.isPackaged) {
    const fromModule = repoRootFromModule();
    if (fs.existsSync(path.join(fromModule, "package.json"))) {
      return fromModule;
    }
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    return cwd;
  }
  throw new Error("Could not locate paprwork repo root for E2E scripts");
}

function findTest(testId: string): ReplicaE2eTestDefinition {
  const test = REPLICA_E2E_TESTS.find((entry) => entry.id === testId);
  if (!test) {
    throw new Error(`Unknown replica E2E test: ${testId}`);
  }
  return test;
}

function buildSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAPR_TURSO_REPLICA_SYNC:
      process.env.PAPR_TURSO_REPLICA_SYNC ?? "replica-records",
    PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION:
      process.env.PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION ?? "1",
    CLOUD_SYNC_ENABLED: process.env.CLOUD_SYNC_ENABLED ?? "true",
    TURSO_SYNC_ENABLED: process.env.TURSO_SYNC_ENABLED ?? "true",
  };
}

function runNpmScript(test: ReplicaE2eTestDefinition): Promise<ReplicaE2eRunResult> {
  if (activeRun) {
    throw new Error(
      `Test already running: ${activeRun.testId}. Cancel it first or wait for completion.`,
    );
  }

  const repoRoot = resolveRepoRoot();
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(npmCmd, ["run", test.npmScript], {
      cwd: repoRoot,
      env: buildSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeRun = { child, testId: test.id, cancelled: false };

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      activeRun = null;
      reject(error);
    });

    child.on("close", (code) => {
      const cancelled = activeRun?.cancelled === true;
      activeRun = null;
      resolve({
        testId: test.id,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        cancelled,
      });
    });
  });
}

export function initializeReplicaE2eTestsIPC(): void {
  ipcMain.handle("replica-e2e:list", async () => ({
    tests: REPLICA_E2E_TESTS,
    available: !app.isPackaged,
    runningTestId: activeRun?.testId ?? null,
  }));

  ipcMain.handle("replica-e2e:run", async (_event, testId: unknown) => {
    if (app.isPackaged) {
      throw new Error(
        "Replica E2E tests are available in dev builds only (npm start from repo).",
      );
    }
    if (typeof testId !== "string" || !testId.trim()) {
      throw new TypeError("replica-e2e:run expects a test id string");
    }
    const test = findTest(testId.trim());
    return runNpmScript(test);
  });

  ipcMain.handle("replica-e2e:cancel", async () => {
    if (!activeRun) {
      return { cancelled: false };
    }
    const testId = activeRun.testId;
    const child = activeRun.child;
    activeRun.cancelled = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, 5000);
    return { cancelled: true, testId };
  });
}
