import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDatabaseDiagnosticTransport, stopDatabaseDiagnosticTransport } from "./databaseDiagnostics/trace.js";
import { fork, type ChildProcess } from "node:child_process";
import { getActiveDiagnosticOperationIds } from "../../core/utils/performanceDiagnostics.js";
import type { WatchdogChildMessage, WatchdogParentMessage, WatchdogSnapshot } from "./performanceWatchdogProtocol.js";

let child: ChildProcess | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let snapshot: WatchdogSnapshot | null = null;
let status = "stopped";
let receivedAt: string | null = null;
let pendingSnapshot = false;
let sendingHeartbeat = false;
let lastRequest = 0;
let traceDirectory: string | undefined;
let traceEndpoint: string | undefined;
function cleanupTraceEndpoint(): void {
  if (process.env.PAPR_DB_DIAGNOSTICS_SOCKET === traceEndpoint) delete process.env.PAPR_DB_DIAGNOSTICS_SOCKET;
  if (traceEndpoint && process.platform !== "win32") { try { unlinkSync(traceEndpoint); } catch {} }
  if (traceDirectory) { try { rmdirSync(traceDirectory); } catch {} }
  traceEndpoint = undefined; traceDirectory = undefined;
}
let bootTimer: ReturnType<typeof setTimeout> | undefined;

export function startPerformanceWatchdog(): void {
  if (child) return;
  if (process.env.NODE_ENV === "test" || process.env.VITEST || process.env.PAPR_PERFORMANCE_WATCHDOG === "0") {
    status = "disabled"; return;
  }
  status = "starting"; snapshot = null; receivedAt = null;
  pendingSnapshot = false; sendingHeartbeat = false; lastRequest = 0;
  if (process.env.PAPR_DATABASE_DIAGNOSTICS !== "0") {
    try {
      traceDirectory = mkdtempSync(path.join(os.tmpdir(), "papr-db-"));
      traceEndpoint = process.platform === "win32" ? String.raw`\\.\pipe` + "\\" + `${path.basename(traceDirectory)}-${process.pid}` : path.join(traceDirectory, "trace.sock");
      process.env.PAPR_DB_DIAGNOSTICS_SOCKET = traceEndpoint;
    } catch { cleanupTraceEndpoint(); }
  }
  let instance: ChildProcess;
  try { instance = fork(new URL("./performanceWatchdogEntry.js", import.meta.url), [], {
    execPath: process.execPath, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  }); } catch { status = "spawn_failed"; cleanupTraceEndpoint(); return; }
  child = instance;
  instance.unref(); instance.channel?.unref();
  const send = (message: WatchdogParentMessage, done: () => void) => {
    if (!instance.connected) { done(); return; }
    instance.send(message, error => { if (error) status = "ipc_error"; done(); });
  };
  const tick = () => {
    if (pendingSnapshot && performance.now() - lastRequest > 15_000) status = "unresponsive";
    if (!sendingHeartbeat) {
      sendingHeartbeat = true;
      send({ type: "heartbeat", operationIds: getActiveDiagnosticOperationIds() }, () => { sendingHeartbeat = false; });
    }
    if (!pendingSnapshot && performance.now() - lastRequest >= 5000) {
      pendingSnapshot = true; lastRequest = performance.now();
      send({ type: "snapshot" }, () => {});
    }
  };
  instance.on("message", (message: WatchdogChildMessage) => {
    if (child !== instance) return;
    if (message.type === "ready") { clearTimeout(bootTimer); bootTimer = undefined; status = "running"; startDatabaseDiagnosticTransport(); tick(); }
    if (message.type === "snapshot") {
      status = "running"; snapshot = message.snapshot; receivedAt = new Date().toISOString(); pendingSnapshot = false;
    }
  });
  instance.on("error", () => { if (child === instance) status = "spawn_or_ipc_error"; });
  instance.on("exit", () => {
    if (child !== instance) return;
    clearTimeout(bootTimer); bootTimer = undefined;
    child = undefined; status = "exited"; stopDatabaseDiagnosticTransport(); cleanupTraceEndpoint();
    if (timer) clearInterval(timer);
    timer = undefined;
  });
  bootTimer = setTimeout(() => {
    if (child === instance) { stopPerformanceWatchdog(); status = "startup_timeout"; }
  }, 15_000); bootTimer.unref();
  timer = setInterval(tick, 500); timer.unref();
}

export function stopPerformanceWatchdog(): void {
  clearTimeout(bootTimer); bootTimer = undefined;
  if (timer) clearInterval(timer);
  timer = undefined;
  const instance = child; child = undefined; status = "stopped";
  if (instance?.connected) instance.disconnect();
  instance?.kill();
  stopDatabaseDiagnosticTransport(); cleanupTraceEndpoint();
}

export function getPerformanceWatchdogDiagnostics() {
  return { status, receivedAt, snapshotAgeMs: snapshot ? Math.max(0, Date.now() - Date.parse(snapshot.capturedAt)) : null,
    sampleIntervalMs: 5000, stallThresholdMs: 2500, stackCooldownMs: 60_000,
    retention: { samples: 120, stacks: 5, stackBytes: 65536 }, snapshot };
}
