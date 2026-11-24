/**
 * Neural Engine first (issue: ANE-first on Apple Silicon). When the helper and CoreML model are on disk the runtime
 * loads CoreML as the primary embedder and does not start the ONNX process at all, unless the Neural Engine fails,
 * dies, or gets a document longer than its longest shape. Fake embedders: no model, no helper.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { aneAvailable, helperPath } from "../../src/core/tools/codeEmbed/coremlEmbedder.js";
import { CODE_EMBED_DIM, l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";

type Fake = Embedder & { onExit?: (l: () => void) => void; die?: () => void; docs: number };
function fake(name: string, o: { slowMs?: number; maxChars?: number; fallback?: Embedder } = {}): Fake {
  const listeners: Array<() => void> = [];
  const vec = (t: string) => { const v = new Float32Array(CODE_EMBED_DIM).fill(0.001); v[t.length % 8] = 1; return l2normalize(v); };
  const e: Fake = {
    model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM, docs: 0,
    embedQuery: async (t) => { if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs)); return vec(t); },
    embedDocuments: async (ts) => {
      const out: Float32Array[] = [];
      for (const t of ts) {
        if (o.maxChars && t.length > o.maxChars && o.fallback) out.push(...(await o.fallback.embedDocuments([t])));
        else { e.docs++; out.push(vec(t)); }
      }
      return out;
    },
    countTokens: (s) => Math.ceil(s.length / 4),
    close: async () => {},
    onExit: (l) => listeners.push(l),
    die: () => listeners.forEach((l) => l()),
  };
  Object.defineProperty(e, "constructor", { value: { name } });
  return e;
}

const dirs: string[] = [];
const rts: CodeEmbedRuntime[] = [];
afterEach(async () => {
  for (const r of rts.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.PAPR_CODE_EMBED_COREML;
  delete process.env.PAPR_CODE_EMBED_HELPER;
});

function project(files: Record<string, string> = { "a.ts": "export const a = 1\n", "b.ts": "export const b = 2\n" }) {
  const base = mkdtempSync(path.join(tmpdir(), "ceane-"));
  dirs.push(base);
  const root = path.join(base, "apps", "11111111-2222-3333-4444-555555555555");
  mkdirSync(root, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(root, f), t);
  return { base, root };
}

function setup(o: { ane?: (base: Embedder) => Promise<Embedder>; aneFirst?: boolean; files?: Record<string, string> } = {}) {
  const { base, root } = project(o.files);
  const log = { onnxStarts: 0, onnx: [] as Fake[], ane: [] as Fake[] };
  const rt = new CodeEmbedRuntime({
    dataDir: path.join(base, "data"), cloud: async () => null, cloudAvailable: false, installed: () => true,
    tierOverride: "local", canRun: () => true, upgradeRetryMs: 20, aneFirst: o.aneFirst ?? true,
    loadEmbedder: async () => { log.onnxStarts++; const e = fake("WorkerOnnxEmbedder"); log.onnx.push(e); return e; },
    loadUpgrade: async (_r, b) => { if (o.ane) return o.ane(b); const e = fake("CoreMLEmbedder", { maxChars: 200, fallback: b }); log.ane.push(e); return e; },
  });
  rts.push(rt);
  return { rt, root, log };
}
const until = async (f: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !f(); t += 20) await new Promise((r) => setTimeout(r, 20)); };

describe("Neural Engine first", () => {
  test("indexes on the Neural Engine and never starts the ONNX process", async () => {
    const { rt, root, log } = setup();
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0);
    expect(rt.backend).toBe("CoreMLEmbedder");
    expect(log.ane[0]!.docs).toBe(2);
    expect(log.onnxStarts).toBe(0);
    expect(rt.info().neuralEngine.onnxStarted).toBe(false);
    expect((await rt.search(root, "a")).hits.length).toBeGreaterThan(0);
  });

  test("a document longer than the Neural Engine takes starts ONNX once, only for that document", async () => {
    const { rt, root, log } = setup({ files: { "a.ts": "export const a = 1\n", "long.ts": `// ${"x".repeat(400)}\n` } });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0);
    expect(rt.backend).toBe("CoreMLEmbedder");
    expect(log.onnxStarts).toBe(1);
    expect(log.onnx[0]!.docs).toBe(1);
    expect(log.ane[0]!.docs).toBe(1);
  });

  test("Neural Engine load fails: ONNX takes over at once, then the Neural Engine is retried and swapped in", async () => {
    let tries = 0;
    const { rt, root, log } = setup({ ane: async (b) => { if (++tries === 1) throw new Error("coreml helper load timeout"); const e = fake("CoreMLEmbedder", { fallback: b }); log.ane.push(e); return e; } });
    rt.touch(root, true);
    expect(await rt.embedder()).not.toBeNull();
    expect(rt.backend).toBe("WorkerOnnxEmbedder");
    expect(rt.info().upgrade).toMatch(/load timeout/);
    await until(() => rt.backend === "CoreMLEmbedder");
    expect(tries).toBe(2);
    expect(log.onnxStarts).toBe(1);
  });

  test("a Neural Engine that fails its speed self-test is not used", async () => {
    const { rt, log } = setup({ ane: async () => fake("CoreMLEmbedder", { slowMs: 600 }) });
    expect(await rt.embedder()).not.toBeNull();
    expect(rt.backend).toBe("WorkerOnnxEmbedder");
    expect(rt.info().upgrade).toMatch(/self-test too slow/);
    expect(log.onnxStarts).toBe(1);
  }, 15_000);

  test("the helper dying mid-session: ONNX takes over, then the Neural Engine comes back", async () => {
    const { rt, root, log } = setup();
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.backend === "CoreMLEmbedder");
    log.ane[0]!.die!();
    await until(() => rt.backend === "WorkerOnnxEmbedder");
    expect(log.onnxStarts).toBe(1);
    await until(() => log.ane.length === 2 && rt.backend === "CoreMLEmbedder");
    expect(rt.backend).toBe("CoreMLEmbedder");
  });

  test("aneFirst false keeps the old order: ONNX first, Neural Engine swapped in", async () => {
    const { rt, log } = setup({ aneFirst: false });
    await rt.embedder();
    expect(log.onnxStarts).toBe(1);
    await until(() => rt.backend === "CoreMLEmbedder");
  });
});

describe("aneAvailable", () => {
  test("not Apple Silicon, turned off, helper missing, model missing", () => {
    const { base } = project();
    expect(aneAvailable(base, "linux", "x64").ok).toBe(false);
    expect(aneAvailable(base, "darwin", "x64").reason).toMatch(/Apple Silicon/);
    process.env.PAPR_CODE_EMBED_COREML = "0";
    expect(aneAvailable(base, "darwin", "arm64").reason).toMatch(/turned off/);
    delete process.env.PAPR_CODE_EMBED_COREML;
    process.env.PAPR_CODE_EMBED_HELPER = path.join(base, "nope");
    const r = aneAvailable(base, "darwin", "arm64");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/helper not found|model not downloaded/);
  });

  test("helperPath finds the dev build from the repo root whatever the cwd is", () => {
    const cwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(helperPath("/nonexistent")).toMatch(/(native\/papr-embed-coreml\/build|bin)\/papr-embed-coreml$/);
    } finally {
      process.chdir(cwd);
    }
  });
});
