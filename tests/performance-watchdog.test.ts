import { describe, expect, test } from "vitest";
import { build } from "esbuild";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { WatchdogLiveness } from "../src/gateway/services/performanceWatchdogState.js";
import { collectHostMeasurements, counterRates, diagnosticCommand, parseMeasurement, parseMemoryPressure, parseProcessTable,
  parseSwapUsage, parseVmStat, sanitizeStack, selectProcesses } from "../src/gateway/services/performanceWatchdogMetrics.js";
import type { WatchdogSnapshot } from "../src/gateway/services/performanceWatchdogProtocol.js";

const vmFixture = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                100.
Pages wired down:                          200.
Pages occupied by compressor:             300.
Pages stored in compressor:                900.
Pageins:                                   50.
Pageouts:                                  20.
Swapins:                                    4.
Swapouts:                                   8.
Compressions:                              25.
Decompressions:                            10.`;

describe("OS diagnostic measurements", () => {
  test("host probes return partial results when OS commands are denied", async () => {
    const sample = await collectHostMeasurements(process.pid);
    expect(sample.totalMemoryBytes).toBeGreaterThan(0);
  });
  test("uses the reported VM page size and separates resident compressor from original size", () => {
    const vm = parseVmStat(vmFixture);
    expect(vm.freeBytes).toBe(100 * 16384);
    expect(vm.compressorBytes).toBe(300 * 16384);
    expect(vm.uncompressedBytesInCompressor).toBe(900 * 16384);
    expect(vm.counters.swapouts).toBe(8);
    expect(parseVmStat(vmFixture.replace("Pages free:", "Missing:" )).freeBytes).toBeNull();
    expect(() => parseVmStat("denied")).toThrow();
  });
  test("parses mixed swap units without treating missing measurements as zero", () => {
    expect(parseSwapUsage("total = 2G used = 512.00M free = 1536M")).toEqual({ totalBytes: 2 * 1024 ** 3, usedBytes: 512 * 1024 ** 2, freeBytes: 1536 * 1024 ** 2 });
    expect(parseSwapUsage("total = 100 used = 0 free = 100").totalBytes).toBe(100);
    expect(parseMeasurement({ status: "available", value: "no data" }, parseSwapUsage).status).toBe("unavailable");
    expect(parseMeasurement({ status: "unavailable", reason: "EPERM" }, parseVmStat)).toEqual({ status: "unavailable", reason: "EPERM" });
  });
  test("uses kernel pressure flags, rejects unknown states", () => {
    expect(parseMemoryPressure("1\n").level).toBe("normal");
    expect(parseMemoryPressure("2").level).toBe("warning");
    expect(parseMemoryPressure("4").level).toBe("critical");
    expect(() => parseMemoryPressure("0")).toThrow();
  });
  test("computes rates over actual elapsed time and rejects reset/missing counters", () => {
    expect(counterRates({ swapins: 20, swapouts: 2, pageins: null }, { swapins: 10, swapouts: 8, pageins: 0 }, 10000))
      .toEqual({ swapins: 1, swapouts: null, pageins: null });
    expect(counterRates({ x: 1 }, { x: 0 }, 0).x).toBeNull();
  });
  test("finds descendants in any order and retains executable names without paths", () => {
    const rows = parseProcessTable("3 2 10.2 200 /usr/bin/python3\n1 0 2.5 100 /Applications/Papr.app/Papr Helper\n2 1 0 50 /usr/bin/node\n4 0 99 999 /usr/bin/unrelated\n");
    const selected = selectProcesses(rows, 1);
    expect(selected.gatewayAndDescendants.map(p => p.pid).sort()).toEqual([1, 2, 3]);
    expect(selected.gatewayAndDescendants.find(p => p.pid === 1)?.executable).toBe("Papr Helper");
    expect(selected.topHostCpu[0].pid).toBe(4);
    expect(selected.topHostMemory[0].rssBytes).toBe(999 * 1024);
    expect(JSON.stringify(selected)).not.toContain("/usr/");
  });
  test("caps retained process lists", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ pid: i + 1, parentPid: i, cpuPercent: i, rssBytes: i, executable: "node" }));
    const selected = selectProcesses(rows, 1);
    expect(selected.gatewayAndDescendants).toHaveLength(64);
    expect(selected.omittedDescendants).toBe(36);
    expect(selected.topHostCpu).toHaveLength(5);
  });
  test("retains only bounded call graphs and removes home paths", () => {
    const result = sanitizeStack("Process: Secret\nPath: /private/app\nCall graph:\n/Users/test/file " + "x".repeat(70000) + "\nBinary Images:\nsecret", "/Users/test");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(65536);
    expect(result.text).toContain("~/file");
    expect(result.text).not.toMatch(/Process:|Binary Images:|\/Users\/test/);
    expect(sanitizeStack("permission denied", "").text).toBe("");
    expect(Buffer.byteLength(sanitizeStack("Call graph:" + "😀".repeat(20000), "").text)).toBeLessThanOrEqual(65536);
  });
  test("commands fail safely, omit raw errors and terminate on timeout", async () => {
    expect(await diagnosticCommand("/definitely-missing-diagnostic-tool", [])).toEqual({ status: "unavailable", reason: "ENOENT" });
    const result = await diagnosticCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], 100);
    expect(result).toEqual({ status: "unavailable", reason: "timeout_or_output_limit" });
  });
});

describe("independent liveness policy", () => {
  test("requires a heartbeat and captures once per continuous stall", () => {
    const policy = new WatchdogLiveness();
    for (let t = 0; t <= 5000; t += 500) expect(policy.tick(t).capture).toBe(false);
    policy.heartbeat(5000);
    for (let t = 5500; t < 7500; t += 500) expect(policy.tick(t).capture).toBe(false);
    expect(policy.tick(7500).capture).toBe(true);
    for (let t = 8000; t < 80000; t += 500) expect(policy.tick(t).capture).toBe(false);
    policy.heartbeat(80000);
    for (let t = 80000; t < 82500; t += 500) expect(policy.tick(t).capture).toBe(false);
    expect(policy.tick(82500).capture).toBe(true);
  });
  test("rate limits separate stalls", () => {
    const policy = new WatchdogLiveness(); policy.heartbeat(0);
    for (let t = 0; t < 2500; t += 500) policy.tick(t);
    expect(policy.tick(2500).capture).toBe(true);
    policy.heartbeat(3000);
    for (let t = 3000; t <= 6000; t += 500) expect(policy.tick(t).capture).toBe(false);
  });
  test("does not blame the gateway immediately after sleep or observer starvation", () => {
    const policy = new WatchdogLiveness(); policy.heartbeat(0); policy.tick(0);
    const resume = policy.tick(30000);
    expect(resume.observerGapMs).toBe(29500);
    expect(resume.capture).toBe(false);
    expect(resume.heartbeatAgeMs).toBe(0);
    policy.heartbeat(30100);
    expect(policy.tick(30500).capture).toBe(false);
  });
});

test("watchdog retains measurements and detects a gateway whose event loop is blocked", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pwt-"));
  let gateway: ReturnType<typeof fork> | undefined;
  try {
    const entry = path.join(directory, "watchdog.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../src/gateway/services/performanceWatchdogEntry.ts", import.meta.url))],
      bundle: true, platform: "node", format: "esm", outfile: entry });
    const traceEntry = path.join(directory, "trace.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../src/gateway/services/databaseDiagnostics/trace.ts", import.meta.url))],
      bundle: true, platform: "node", format: "esm", outfile: traceEntry });
    const fixture = path.join(directory, "gateway.mjs");
    await writeFile(fixture, `import { fork } from 'node:child_process';
      import { DatabaseConnectionTrace, getDatabaseDiagnosticTransportStatus } from ${JSON.stringify(traceEntry)};
      const child = fork(${JSON.stringify(entry)}, [], {execArgv: [], stdio: ['ignore','ignore','ignore','ipc']});
      process.on('disconnect', () => { child.kill(); process.exit(0); });
      child.on('error', () => process.exit(2));
      let blockStartedAt, blockFinishedAt;
      child.on('message', async message => {
        if (message.type === 'ready') {
          const trace = new DatabaseConnectionTrace('/tmp/test-gateway.db', 'blocked-gateway-test', 'better-sqlite3');
          while (!getDatabaseDiagnosticTransportStatus().connected) await new Promise(resolve => setTimeout(resolve, 20));
          child.send({type:'heartbeat', operationIds:['test-operation']});
          setTimeout(() => {
            trace.begin("prepare:read");
            blockStartedAt = Date.now();
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8500);
            blockFinishedAt = Date.now();
            child.send({type:'snapshot'});
          }, 250);
        } else {
          process.send({...message, blockStartedAt, blockFinishedAt}, () => { child.disconnect(); });
        }
      });`);
    gateway = fork(fixture, [], { execArgv: [], env: { ...process.env, PAPR_PERFORMANCE_STACK_SAMPLES: "0", PAPR_DB_DIAGNOSTICS_SOCKET: process.platform === "win32" ? String.raw`\\.\pipe` + "\\" + path.basename(directory) : path.join(directory, "d.sock") },
      stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const [message] = await once(gateway, "message") as [{ snapshot: WatchdogSnapshot; blockStartedAt: number; blockFinishedAt: number }];
    const { snapshot, blockStartedAt, blockFinishedAt } = message;
    expect(snapshot.collectionFailures).toBe(0);
    expect(snapshot.gatewayPid).toBe(gateway.pid);
    const stall = snapshot.stalls[0];
    expect(stall.lastKnownOperationIds).toEqual(["test-operation"]);
    expect(Date.parse(stall.detectedAt)).toBeGreaterThan(blockStartedAt);
    expect(Date.parse(stall.detectedAt)).toBeLessThan(blockFinishedAt);
    expect(stall.stack).toEqual({ status: "unavailable", reason: "disabled" });
    expect(snapshot.databases?.status).toBe("listening");
    expect(stall.databaseEvidence?.waitingCandidates[0].waiting).toMatchObject({ owner: "blocked-gateway-test", pid: gateway.pid });
    expect(snapshot.samples.some(sample => Date.parse(sample.startedAt) > blockStartedAt && Date.parse(sample.finishedAt) < blockFinishedAt)).toBe(true);
  } finally {
    gateway?.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
