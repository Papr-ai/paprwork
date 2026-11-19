/** Background indexing pauses on low battery, Low Power Mode, a hot CPU and memory pressure; search never does. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as health from "../../src/core/tools/codeEmbed/deviceHealth.js";
import { CODE_EMBED_DIM, l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";

const GB = 1024 ** 3;
const calm: health.PowerState = { onBattery: false, batteryPct: 100, lowPowerMode: false, cpuSpeedLimit: 100, memoryPressure: 1, swapUsedBytes: 1 * GB };

describe("throttleReason", () => {
  test("runs on a calm machine", () => expect(health.throttleReason(calm, 4 * GB, 1 * GB)).toBeNull());
  test("Low Power Mode", () => expect(health.throttleReason({ ...calm, lowPowerMode: true }, 4 * GB, null)).toBe("Low Power Mode"));
  test("battery below 30% only when on battery", () => {
    expect(health.throttleReason({ ...calm, onBattery: true, batteryPct: 25 }, 4 * GB, null)).toMatch(/battery at 25%/);
    expect(health.throttleReason({ ...calm, onBattery: true, batteryPct: 60 }, 4 * GB, null)).toBeNull();
    expect(health.throttleReason({ ...calm, onBattery: false, batteryPct: 10 }, 4 * GB, null)).toBeNull(); // charging
  });
  test("thermal limit", () => expect(health.throttleReason({ ...calm, cpuSpeedLimit: 70 }, 4 * GB, null)).toMatch(/thermally limited to 70%/));
  test("memory pressure warning and critical", () => {
    expect(health.throttleReason({ ...calm, memoryPressure: 2 }, 4 * GB, null)).toBe("memory pressure warning");
    expect(health.throttleReason({ ...calm, memoryPressure: 4 }, 4 * GB, null)).toBe("memory pressure critical");
  });
  test("Neural Engine (light) keeps indexing on a memory warning and under 2 GB free; still waits on critical", () => {
    expect(health.throttleReason({ ...calm, memoryPressure: 2 }, 1 * GB, null, { light: true })).toBeNull();
    expect(health.throttleReason({ ...calm, memoryPressure: 4 }, 4 * GB, null, { light: true })).toBe("memory pressure critical");
    expect(health.throttleReason({ ...calm, lowPowerMode: true }, 4 * GB, null, { light: true })).toBe("Low Power Mode");
    expect(health.throttleReason({ ...calm, swapUsedBytes: 20 * GB }, 4 * GB, 19 * GB, { light: true })).toBe("swap growing");
  });
  test("swap growing fast, not swap merely large", () => {
    expect(health.throttleReason({ ...calm, swapUsedBytes: 20 * GB }, 4 * GB, 19.9 * GB)).toBeNull();
    expect(health.throttleReason({ ...calm, swapUsedBytes: 20 * GB }, 4 * GB, 19 * GB)).toBe("swap growing");
  });
  test("low available memory", () => expect(health.throttleReason(calm, 1 * GB, null)).toBe("low free memory"));
  test("readPowerState never throws and fills every field", () => {
    const s = health.readPowerState(0);
    expect(Object.keys(s).sort()).toEqual(["batteryPct", "cpuSpeedLimit", "lowPowerMode", "memoryPressure", "onBattery", "swapUsedBytes"]);
  });
});

describe("runtime pauses indexing, not search", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

  test("paused on Low Power Mode with the reason in status; resumes when it clears; search still answers", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "cethr-")); dirs.push(base);
    const root = path.join(base, "apps", "11111111-2222-3333-4444-555555555555");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "a.ts"), "export const retry = 1\n");
    let state = { ...calm, lowPowerMode: true };
    vi.spyOn(health, "readPowerState").mockImplementation(() => state);
    vi.spyOn(health, "availableMemBytes").mockReturnValue(8 * GB);
    const vec = () => l2normalize(new Float32Array(CODE_EMBED_DIM).fill(0.03));
    const emb: Embedder = { model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM, embedQuery: async () => vec(), embedDocuments: async (t) => t.map(vec), countTokens: (s) => s.length, close: async () => {} };
    const rt = new CodeEmbedRuntime({ dataDir: path.join(base, "data"), cloud: async () => null, cloudAvailable: false, installed: () => true, tierOverride: "local", loadEmbedder: async () => emb, loadUpgrade: null, aneFirst: false });
    try {
      rt.touch(root, true);
      await rt.embedder();
      expect((await rt.indexer.embedPending(4)).skipped).toBe("device busy");
      expect(rt.info().indexingPaused).toBe("Low Power Mode");
      expect((await rt.search(root, "retry")).tier).toBe("local"); // search runs while indexing waits
      state = calm;
      expect((await rt.indexer.embedPending(4)).embedded).toBe(1);
      expect(rt.info().indexingPaused).toBeNull();
    } finally {
      await rt.close();
    }
  });
});
