/** Rolling performance numbers in /api/code-embed/status: search p50/p95, ms per indexed chunk, average cores. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { describe, expect, test } from "vitest";
import { CODE_EMBED_DIM, l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { IndexCpu, Samples, cpuSeconds } from "../../src/core/tools/codeEmbed/perfStats.js";
import { CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";

describe("perf stats", () => {
  test("Samples: percentiles over a capped window", () => {
    const s = new Samples(5);
    expect(s.pct(50)).toBeNull();
    [10, 20, 30, 40, 50, 1000].forEach((x) => s.add(x)); // 10 drops out
    expect(s.count).toBe(5);
    expect(s.pct(50)).toBe(40);
    expect(s.pct(95)).toBe(1000);
  });
  test("IndexCpu: cores = CPU seconds / wall seconds over batches", () => {
    const c = new IndexCpu();
    expect(c.cores).toBeNull();
    c.addBatch(0.5, 2);
    c.addBatch(1.5, 2);
    expect(c.cores).toBe(0.5);
  });
  test.skipIf(process.platform === "win32")("cpuSeconds reads this process", () => {
    const end = Date.now() + 300;
    while (Date.now() < end); // burn CPU so a fresh test worker has measurable time
    const s = cpuSeconds(process.pid);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0);
    expect(cpuSeconds(999_999_9)).toBeNull();
  });
  test("status reports search latency and indexing numbers", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ceperf-"));
    const root = path.join(base, "apps", "11111111-2222-3333-4444-555555555555");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "a.ts"), "export const retry = 1\n");
    const vec = () => l2normalize(new Float32Array(CODE_EMBED_DIM).fill(0.03));
    const emb: Embedder = { model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM, embedQuery: async () => vec(), embedDocuments: async (t) => t.map(vec), countTokens: (s) => s.length, close: async () => {} };
    const rt = new CodeEmbedRuntime({ dataDir: path.join(base, "data"), cloud: async () => null, cloudAvailable: false, installed: () => true, tierOverride: "local", loadEmbedder: async () => emb, loadUpgrade: null, aneFirst: false, canRun: () => true });
    try {
      rt.touch(root, true);
      await rt.embedder();
      for (let i = 0; i < 50 && rt.store.pendingBlobs(root).length; i++) await new Promise((r) => setTimeout(r, 20));
      await rt.search(root, "retry");
      await rt.search(root, "retry again");
      const p = rt.info().perf;
      expect(p.searchMs.n).toBe(2);
      expect(p.searchMs.p50).not.toBeNull();
      expect(p.searchMs.budgetP50).toBe(100);
      expect(p.indexMsPerChunk.n).toBeGreaterThanOrEqual(1);
      expect(p.indexCores.budget).toBe(1);
    } finally {
      await rt.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
