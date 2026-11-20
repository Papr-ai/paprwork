/**
 * Resource governor: memory-heavy agent commands must not be able to take the machine down (Nov 19 kernel panic:
 * four agent-started model processes, 18 GB, on a 16 GB Mac already holding 54 GB of browser tabs; the compressor hit
 * its limit and the watchdog panicked). Simulated pressure, so it runs the same on macOS, Linux and Windows CI.
 */
import { describe, expect, test } from "vitest";
import {
  classifyPressure, parseMeminfo, parsePsi, parseSwapUsage, parseVmStat, psiToLevel, type MemorySnapshot,
} from "../../src/core/system/memoryPressure.js";
import { commandSignature, estimateCommandCost, HEAVY_LEARNED_BYTES } from "../../src/core/system/commandCost.js";
import { parsePs, treeOf, treeRss, type ProcRow } from "../../src/core/system/processTree.js";
import { agentCapFor, maxHeavyFor, reserveFor, ResourceGovernor } from "../../src/core/system/resourceGovernor.js";

const GB = 1024 ** 3;
const snap = (o: Partial<MemorySnapshot> = {}): MemorySnapshot => ({
  at: 0, platform: "darwin", totalBytes: 16 * GB, availableBytes: 9 * GB, compressorBytes: 1 * GB,
  compressorLimitShare: 0.1, osPressureLevel: 1, swapUsedBytes: 500 * 1024 ** 2, psiSome10: null, ...o,
});

describe("pressure sensor parsing (per platform)", () => {
  test("macOS vm_stat: available = free + inactive + speculative + purgeable; compressor pages", () => {
    const v = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               14925.
Pages active:                            203161.
Pages inactive:                          204276.
Pages speculative:                         3863.
Pages purgeable:                           1852.
Pages occupied by compressor:            168639.`);
    expect(v).toEqual({ pageSize: 16384, availablePages: 14925 + 204276 + 3863 + 1852, compressorPages: 168639 });
    expect(parseSwapUsage("total = 2048.00M  used = 554.00M  free = 1494.00M  (encrypted)")).toBe(554 * 1024 * 1024);
  });

  test("Linux /proc/meminfo and PSI", () => {
    const mi = parseMeminfo("MemTotal:       16000000 kB\nMemAvailable:    2000000 kB\nSwapTotal:       4000000 kB\nSwapFree:        1000000 kB\n");
    expect(mi.availableBytes).toBe(2000000 * 1024);
    expect(mi.swapUsedBytes).toBe(3000000 * 1024);
    const psi = parsePsi("some avg10=42.50 avg60=10.00 avg300=2.00 total=1\nfull avg10=5.00 avg60=1.00 avg300=0.00 total=1");
    expect(psi).toBe(42.5);
    expect(psiToLevel(psi)).toBe(4);
    expect(psiToLevel(12)).toBe(2);
    expect(psiToLevel(0.5)).toBe(1);
  });

  test("ps rows → process trees and their memory", () => {
    const rows = parsePs("  1 0 1000\n 10 1 2000\n 11 10 3000\n 12 10 4000\n 20 1 9999\n");
    expect(treeOf(10, rows).map((r) => r.pid).sort()).toEqual([10, 11, 12]);
    expect(treeRss(10, rows)).toBe((2000 + 3000 + 4000) * 1024);
  });
});

describe("pressure states", () => {
  test("a healthy Mac is green", () => expect(classifyPressure(snap()).state).toBe("green"));

  test("the Nov 19 shape is critical: compressor at 88% of its limit", () => {
    const c = classifyPressure(snap({ availableBytes: 0.2 * GB, compressorBytes: 4.2 * GB, compressorLimitShare: 0.88 }));
    expect(c.state).toBe("critical");
    expect(c.reasons.join(" ")).toMatch(/compressor at 88%/);
  });

  test("low available memory or a growing swap raises the state", () => {
    expect(classifyPressure(snap({ availableBytes: 2 * GB })).state).toBe("yellow");
    expect(classifyPressure(snap({ availableBytes: 1 * GB })).state).toBe("red");
    expect(classifyPressure(snap({ swapUsedBytes: 2 * GB }), snap()).state).toBe("red");
  });

  test("Windows has no compressor signal: available memory alone decides", () => {
    const w = { platform: "win32" as const, compressorBytes: null, compressorLimitShare: null, osPressureLevel: null, swapUsedBytes: null };
    expect(classifyPressure(snap({ ...w, availableBytes: 8 * GB })).state).toBe("green");
    expect(classifyPressure(snap({ ...w, availableBytes: 1 * GB })).state).toBe("red");
  });
});

describe("command cost", () => {
  test.each([
    "cd ~/Developer/mem-bulk && ~/.cache/papr/bulkvenv/bin/python serving/papr_embed_bulk/e2e_local.py --model qwen3-embedding-0.6b --rows 1000 --workers 2 --device cpu",
    "python3 worker.py --root gs://x --job ebj_1 --device mps",
    "python -c 'import torch; from transformers import AutoModel'",
    "ollama run qwen3:8b",
    "docker run --rm -it pytorch/pytorch",
    "torchrun --nproc_per_node=2 train.py",
  ])("heavy: %s", (cmd) => expect(estimateCommandCost(cmd).cls).toBe("heavy"));

  test.each([
    "grep -rn loadData ~/Papr/apps/x",
    "git status && git log --oneline -3",
    "ls -la; cat README.md | head",
    "curl -s https://example.com",
    "sqlite3 db.sqlite 'select 1'",
  ])("light: %s", (cmd) => expect(estimateCommandCost(cmd).cls).toBe("light"));

  test("medium: test suites and plain scripts", () => {
    expect(estimateCommandCost("npx vitest run tests/x.test.ts").cls).toBe("medium");
    expect(estimateCommandCost("python3 scripts/report.py").cls).toBe("medium");
  });

  test("a command shape that once peaked high is heavy next time", () => {
    const cmd = "python3 scripts/report.py";
    const sig = commandSignature(cmd);
    const c = estimateCommandCost(cmd, { [sig]: HEAVY_LEARNED_BYTES + GB });
    expect(c.cls).toBe("heavy");
    expect(c.estimateBytes).toBeGreaterThan(HEAVY_LEARNED_BYTES);
  });
});

test("a name that looks heavy but measured small is demoted", () => {
  const cmd = "python3 scripts/eval_report.py";
  expect(estimateCommandCost(cmd).cls).toBe("heavy");
  expect(estimateCommandCost(cmd, { [commandSignature(cmd)]: 200 * 1024 ** 2 }).cls).toBe("medium");
});

describe("caps by machine", () => {
  test("agents and heavy leases scale with RAM; 3 GB / 20% reserve", () => {
    expect([8, 16, 32, 64].map((g) => agentCapFor(g * GB))).toEqual([2, 4, 6, 8]);
    expect([8, 16, 32, 64].map((g) => maxHeavyFor(g * GB))).toEqual([1, 1, 2, 4]);
    expect(reserveFor(16 * GB)).toBe(3.2 * GB);
    expect(reserveFor(8 * GB)).toBe(3 * GB);
  });
});

/** A governor over a fake machine: memory, processes and signals are all simulated. */
function fakeMachine(totalGb = 16) {
  let s = snap({ totalBytes: totalGb * GB, availableBytes: 10 * GB });
  let t = 0;
  let rows: ProcRow[] = [];
  const signals: Array<[number, string]> = [];
  const alive = new Set<number>();
  const g = new ResourceGovernor({
    sample: async () => ({ ...s, at: t }),
    processes: async () => rows,
    signal: (pid, _rows, sig) => { signals.push([pid, sig]); if (sig === "SIGKILL") alive.delete(pid); return 1; },
    alive: (pid) => alive.has(pid),
    now: () => t,
    totalBytes: totalGb * GB,
    learnedFile: null,
    enabled: true,
    platform: "darwin",
  });
  return {
    g, signals,
    set: (o: Partial<MemorySnapshot>) => { s = { ...s, ...o }; },
    advance: (ms: number) => { t += ms; },
    spawn: (pid: number, gb: number) => { alive.add(pid); rows = [...rows.filter((r) => r.pid !== pid), { pid, ppid: 1, rssBytes: gb * GB }]; },
    setRss: (pid: number, gb: number) => { rows = rows.map((r) => (r.pid === pid ? { ...r, rssBytes: gb * GB } : r)); },
  };
}

const MODEL = "python3 serving/papr_embed_bulk/e2e_local.py --model qwen3-embedding-0.6b --workers 2 --device cpu";

describe("leases: the Nov 19 run on a 16 GB Mac", () => {
  test("first model load starts; the second waits and is refused with a reason", async () => {
    const m = fakeMachine(16);
    const a = await m.g.acquire(MODEL, "chat-1", { waitMs: 0 });
    expect(a.ok).toBe(true);
    m.g.track(101, "chat-1", MODEL, a.ok ? a.lease : null);
    m.spawn(101, 5.6);
    await m.g.tick();
    const b = await m.g.acquire(MODEL, "chat-2", { waitMs: 0 });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.message).toMatch(/already running \(limit 1/);
      expect(b.message).toMatch(/e2e_local\.py.*5\.6 GB, pid 101/);
      expect(b.message).toMatch(/cloud job/);
    }
  });

  test("yellow alone does not refuse when the budget fits (Macs with many tabs sit at 'warning' all day)", async () => {
    const m = fakeMachine(16);
    m.set({ osPressureLevel: 2, availableBytes: 9 * GB });
    expect((await m.g.acquire(MODEL, "chat-1", { waitMs: 0 })).ok).toBe(true);
  });

  test("red refuses a heavy command even if the numbers look fine", async () => {
    const m = fakeMachine(16);
    m.set({ compressorLimitShare: 0.65 });
    const r = await m.g.acquire(MODEL, "chat-1", { waitMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/memory is tight \(compressor at 65% of its limit/);
  });

  test("light commands always run, even in red", async () => {
    const m = fakeMachine(16);
    m.set({ availableBytes: 0.5 * GB });
    const r = await m.g.acquire("grep -rn foo .", "chat-1", { waitMs: 0 });
    expect(r.ok && r.lease === null).toBe(true);
  });

  test("a heavy command is refused when it would eat into the reserve", async () => {
    const m = fakeMachine(16);
    m.set({ availableBytes: 6 * GB });
    const r = await m.g.acquire(MODEL, "chat-1", { waitMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/needs about 4\.0 GB and only 6\.0 GB is available \(keeping 3\.2 GB free/);
  });

  test("releasing the lease lets the next one start, and its peak is learned", async () => {
    const m = fakeMachine(32);
    const a = await m.g.acquire(MODEL, "chat-1", { waitMs: 0 });
    m.g.track(101, "chat-1", MODEL, a.ok ? a.lease : null);
    m.spawn(101, 5.6);
    await m.g.tick();
    m.g.finish(101, a.ok ? a.lease : null);
    expect(m.g.learned.all[commandSignature(MODEL)]).toBeCloseTo(5.6 * GB, -6);
    expect(m.g.classify(MODEL).estimateBytes).toBeGreaterThan(6 * GB);
  });
});

describe("watchdog", () => {
  test("red: pauses the newest heavy tree (never the only one), resumes when memory clears", async () => {
    const m = fakeMachine(16);
    m.g.track(101, "chat-1", MODEL, null);
    m.spawn(101, 5.6);
    m.advance(1000);
    m.g.track(102, "chat-2", MODEL, null);
    m.spawn(102, 3.5);
    m.set({ availableBytes: 1 * GB, compressorLimitShare: 0.65 });
    await m.g.tick();
    expect(m.signals).toContainEqual([102, "SIGSTOP"]);
    expect(m.signals).not.toContainEqual([101, "SIGSTOP"]);
    m.set({ availableBytes: 9 * GB, compressorLimitShare: 0.2 });
    await m.g.tick();
    m.advance(11_000);
    await m.g.tick();
    expect(m.signals).toContainEqual([102, "SIGCONT"]);
  });

  test("critical twice: stops the largest agent tree and tells its agent", async () => {
    const m = fakeMachine(16);
    m.g.track(101, "chat-1", MODEL, null);
    m.g.track(102, "chat-2", MODEL, null);
    m.spawn(101, 5.6);
    m.spawn(102, 3.5);
    m.set({ availableBytes: 0.2 * GB, compressorLimitShare: 0.88 });
    await m.g.tick();
    await m.g.tick();
    expect(m.signals).toContainEqual([101, "SIGKILL"]);
    const note = m.g.finish(101);
    expect(note ?? "").toMatch(/Stopped by Papr/);
  });

  test("never touches small trees (a 100 MB process is not the problem)", async () => {
    const m = fakeMachine(16);
    m.g.track(201, "chat-1", "python3 scripts/report.py", null);
    m.spawn(201, 0.1);
    m.set({ availableBytes: 0.2 * GB, compressorLimitShare: 0.88 });
    await m.g.tick();
    await m.g.tick();
    expect(m.signals).toEqual([]);
  });

  test("agent cap: none while healthy, halved in red, 1 in critical", async () => {
    const m = fakeMachine(16);
    await m.g.refresh();
    expect(m.g.agentCap()).toBeNull();
    m.set({ availableBytes: 1 * GB });
    await m.g.refresh();
    expect(m.g.agentCap()).toBe(2);
    m.set({ compressorLimitShare: 0.9 });
    await m.g.refresh();
    expect(m.g.agentCap()).toBe(1);
  });

  test("disabled (PAPR_RESOURCE_GOVERNOR=0): everything runs, no cap", async () => {
    const g = new ResourceGovernor({ enabled: false, sample: async () => snap({ availableBytes: 0.1 * GB }), learnedFile: null });
    expect((await g.acquire(MODEL, "chat-1", { waitMs: 0 })).ok).toBe(true);
    expect(g.agentCap()).toBeNull();
  });
});
