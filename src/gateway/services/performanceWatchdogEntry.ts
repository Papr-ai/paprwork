import { DatabaseDiagnosticCollector } from "./databaseDiagnostics/collector.js";
/** Deliberately isolated: no gateway services, DB connections or application boot. */
import { performance } from "node:perf_hooks";
import { captureNativeStack, collectHostMeasurements, counterRates } from "./performanceWatchdogMetrics.js";
import { WatchdogLiveness } from "./performanceWatchdogState.js";
import type { HostSample, StallEvidence, WatchdogParentMessage, WatchdogSnapshot } from "./performanceWatchdogProtocol.js";

const gatewayPid = process.ppid;
const databases = new DatabaseDiagnosticCollector();
const liveness = new WatchdogLiveness();
const samples: HostSample[] = [];
const stalls: StallEvidence[] = [];
const observerGaps: WatchdogSnapshot["observerGaps"] = [];
let operationIds: string[] = [];
let heartbeatAgeMs: number | null = null;
let measuring = false;
let collectionFailures = 0;
let samplingStack = false;
let sending = false;
let previousVm: { mono: number; counters: Record<string, number | null> } | undefined;

async function measure(): Promise<void> {
  if (measuring) return;
  measuring = true;
  try {
    const sample = await collectHostMeasurements(gatewayPid);
    const mono = performance.now();
    const vm = sample.virtualMemory;
    const interval = previousVm && vm.status === "available" ? mono - previousVm.mono : null;
    samples.push({ ...sample, vmRateIntervalMs: interval,
      vmCounterRatesPerSecond: vm.status === "available" && previousVm && interval !== null ?
        counterRates(vm.value.counters, previousVm.counters, interval) : null });
    if (samples.length > 120) samples.shift();
    previousVm = vm.status === "available" ? { mono, counters: vm.value.counters } : undefined;
  } catch { collectionFailures++; } finally { measuring = false; }
}

process.on("message", (message: WatchdogParentMessage) => {
  if (message.type === "heartbeat") {
    liveness.heartbeat(performance.now());
    operationIds = message.operationIds.slice(0, 256);
  } else if (message.type === "snapshot" && !sending && process.connected) {
    sending = true;
    process.send?.({ type: "snapshot", snapshot: { capturedAt: new Date().toISOString(), pid: process.pid,
      gatewayPid, samples, stalls, observerGaps, heartbeatAgeMs, collectionFailures, databases: databases.snapshot() } }, () => { sending = false; });
  }
});
process.on("disconnect", () => process.exit(0));
setInterval(() => {
  const check = liveness.tick(performance.now());
  heartbeatAgeMs = check.heartbeatAgeMs;
  if (check.observerGapMs > 1500) {
    observerGaps.push({ detectedAt: new Date().toISOString(), durationMs: check.observerGapMs });
    if (observerGaps.length > 30) observerGaps.shift();
  }
  if (check.capture && !samplingStack) {
    const evidence: StallEvidence = { detectedAt: new Date().toISOString(), heartbeatAgeMs: check.heartbeatAgeMs!,
      lastKnownOperationIds: [...operationIds], databaseEvidence: databases.evidence(gatewayPid), stack: { status: "collecting" } };
    stalls.push(evidence);
    if (stalls.length > 5) stalls.shift();
    samplingStack = true;
    void captureNativeStack(gatewayPid).then(stack => {
        evidence.stack = stack;
        if (stack.status === "available") {
          const mainThread = stack.value.text.split(/\n    \d+ Thread_/)[1] ?? "";
          evidence.nativeDatabaseLockWait = mainThread.includes("main-thread") && mainThread.includes("sqliteDefaultBusyCallback");
        }
      })
      .catch(() => { evidence.stack = { status: "unavailable", reason: "sampling_failed" }; })
      .finally(() => { evidence.stackFinishedAt = new Date().toISOString(); samplingStack = false; });
  }
}, 500);
setInterval(() => { void measure(); }, 5000);
void measure();
const endpoint = process.env.PAPR_DB_DIAGNOSTICS_SOCKET;
if (endpoint) await databases.listen(endpoint);
process.send?.({ type: "ready" });
