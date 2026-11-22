/**
 * Elliott's crash loop (Nov 17): onnxruntime aborted natively (SIGTRAP in BFCArena::Extend) inside a worker thread,
 * which killed the gateway; the indexer resumed on the same file after every restart. Covers:
 *  - the embedder runs in a child process: a native abort kills only the child, pending calls reject, onExit fires
 *  - a blob that fails or crashes is quarantined after QUARANTINE_AFTER tries (no loop)
 *  - a blob left in flight by a crash of the whole process is counted on the next start
 *  - crash backoff, and CRASH_LIMIT crashes turn the local tier off (persisted) and fall back to cloud
 *  - PAPR_CODE_EMBED_LOCAL=0 never runs the model on device
 *  - the ONNX session disables the CPU arena and documents are capped at 2048 tokens
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { CODE_EMBED_DIM, l2normalize, MAX_DOC_TOKENS, WorkerOnnxEmbedder, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { QUARANTINE_AFTER } from "../../src/core/tools/codeEmbed/codeIndexer.js";
import { CHUNK_TOKENS, chunkFile, MAX_CHUNKS_PER_FILE } from "../../src/core/tools/codeEmbed/chunker.js";
import { CRASH_LIMIT, CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";
import { gitBlobSha } from "../../src/core/tools/codeEmbed/vectorStore.js";

const FAKE_CHILD = path.join(__dirname, "../fixtures/fake-embed-child.mjs");
const tok = { encode: (s: string) => ({ ids: s.split(/\s+/).filter(Boolean).map(() => 1) }) };
const dirs: string[] = [];
const rts: CodeEmbedRuntime[] = [];
const kids: WorkerOnnxEmbedder[] = [];
afterEach(async () => {
  for (const k of kids.splice(0)) await k.close();
  for (const r of rts.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.PAPR_CODE_EMBED_LOCAL;
});

/** A fake embedder that "crashes" (rejects + fires onExit, like the child process) on documents containing CRASH. */
function crashyEmbedder(log: { loads: number; crashes: number }) {
  log.loads++;
  const listeners: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  const vec = () => { const v = new Float32Array(CODE_EMBED_DIM).fill(0.001); v[0] = 1; return l2normalize(v); };
  const e: Embedder & { onExit: (l: any) => void; dead: boolean } = {
    model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM, dead: false,
    embedQuery: async () => vec(),
    embedDocuments: async (ts) => {
      if (ts.some((t) => t.includes("CRASH"))) {
        e.dead = true; log.crashes++;
        setTimeout(() => listeners.forEach((l) => l({ code: null, signal: "SIGTRAP" })), 0);
        throw new Error("embed process exited (SIGTRAP)");
      }
      return ts.map(vec);
    },
    countTokens: (s) => Math.ceil(s.length / 4),
    close: async () => {},
    onExit: (l) => listeners.push(l),
  };
  return e;
}

function project(files: Record<string, string>) {
  const base = mkdtempSync(path.join(tmpdir(), "cec-"));
  dirs.push(base);
  const root = path.join(base, "apps", "11111111-2222-3333-4444-555555555555");
  mkdirSync(root, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(root, f), t);
  return { base, root };
}

function runtime(base: string, o: Partial<ConstructorParameters<typeof CodeEmbedRuntime>[0]> = {}) {
  const rt = new CodeEmbedRuntime({
    dataDir: path.join(base, "data"), cloud: async () => null, cloudAvailable: true,
    installed: () => true, loadUpgrade: null, tierOverride: "local", canRun: () => true, ...o,
  });
  rts.push(rt);
  return rt;
}

const until = async (f: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !f(); t += 25) await new Promise((r) => setTimeout(r, 25)); };

describe("on-device embedder crash isolation (child process)", () => {
  test("a native abort kills only the child: the call rejects, onExit fires, this process lives on", async () => {
    const e = await WorkerOnnxEmbedder.start("/nonexistent", { entry: FAKE_CHILD, tok });
    kids.push(e);
    const exits: string[] = [];
    e.onExit((i) => exits.push(String(i.signal ?? i.code)));
    expect((await e.embedDocuments(["fine"]))[0]).toBeInstanceOf(Float32Array);
    const pid = e.pid!;
    await expect(e.embedDocuments(["CRASH here"])).rejects.toThrow(/exited/);
    await until(() => exits.length > 0);
    expect(exits).toEqual(["SIGTRAP"]);
    expect(() => process.kill(pid, 0)).toThrow(); // child is gone
    await expect(e.embedQuery("after")).rejects.toThrow(/not running/);
  });

  test("close() is not reported as a crash", async () => {
    const e = await WorkerOnnxEmbedder.start("/nonexistent", { entry: FAKE_CHILD, tok });
    const exits: unknown[] = [];
    e.onExit((i) => exits.push(i));
    await e.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(exits).toEqual([]);
  });
});

describe("runtime: no crash loop", () => {
  test("a crashing file is quarantined, the rest still index, and the crash limit falls back to cloud", async () => {
    const { base, root } = project({ "ok.ts": "export const ok = 1\n", "bad.ts": "CRASH CRASH\n", "also.ts": "export const also = 2\n" });
    const log = { loads: 0, crashes: 0 };
    const rt = runtime(base, { loadEmbedder: async () => crashyEmbedder(log) });
    (rt as any).retryAt = 0;
    rt.touch(root, true);
    const bad = gitBlobSha(readFileSync(path.join(root, "bad.ts")));
    for (let i = 0; i < 40 && rt.indexer.localPending().includes(bad); i++) {
      (rt as any).retryAt = 0; // skip the real backoff
      await rt.indexer.embedPending(4);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(log.crashes).toBe(QUARANTINE_AFTER); // tried twice, then never again
    expect(rt.indexer.localPending()).toEqual([]);
    expect(rt.store.pendingBlobs()).toEqual([bad]); // still pending for the cloud tier
    expect(rt.store.stats().files).toBe(3);
  });

  test("backoff: after a crash the embedder is not reloaded until retryAt", async () => {
    const { base, root } = project({ "bad.ts": "CRASH\n" });
    const log = { loads: 0, crashes: 0 };
    const rt = runtime(base, { loadEmbedder: async () => crashyEmbedder(log) });
    rt.touch(root, true);
    await rt.indexer.embedPending(4);
    await until(() => log.crashes === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await rt.embedder()).toBeNull();
    expect(log.loads).toBe(1);
    expect((rt as any).retryAt).toBeGreaterThan(Date.now() + 20_000);
    expect(rt.status).toMatch(/crashed \(SIGTRAP\)/);
  });

  test(`${CRASH_LIMIT} crashes turn the local tier off, persisted across restarts`, async () => {
    const { base, root } = project(Object.fromEntries([...Array(CRASH_LIMIT)].map((_, i) => [`b${i}.ts`, `CRASH ${i}\n`])));
    const log = { loads: 0, crashes: 0 };
    const rt = runtime(base, { loadEmbedder: async () => crashyEmbedder(log) });
    rt.touch(root, true);
    for (let i = 0; i < 20 && rt.tier === "local"; i++) {
      (rt as any).retryAt = 0;
      await rt.indexer.embedPending(1);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rt.tier).toBe("cloud");
    expect(rt.tierReasons[0]).toMatch(/crashed 3 times/);
    await rt.close(); rts.splice(rts.indexOf(rt), 1);
    const again = runtime(base, { loadEmbedder: async () => crashyEmbedder(log) });
    expect(again.tier).toBe("cloud"); // a restart does not re-arm the loop
  });

  test("a blob left in flight by a whole-process crash counts on the next start; twice quarantines it", async () => {
    const { base, root } = project({ "bad.ts": "boom\n" });
    const bad = gitBlobSha(readFileSync(path.join(root, "bad.ts")));
    for (let i = 0; i < QUARANTINE_AFTER; i++) {
      const rt = runtime(base);
      rt.touch(root, true);
      rt.store.setInflight(bad); // what an old build leaves when ONNX aborts the gateway mid-embed
      // The process dies: no clean close() (that clears the marker, see code-embed-resilience.test.ts).
      rt.indexer.stop(); rt.store.close(); rts.splice(rts.indexOf(rt), 1);
    }
    const next = runtime(base);
    expect(next.store.quarantined(QUARANTINE_AFTER).has(bad)).toBe(true);
    expect(next.indexer.localPending()).not.toContain(bad);
  });

  test("PAPR_CODE_EMBED_LOCAL=0 never loads the model", async () => {
    process.env.PAPR_CODE_EMBED_LOCAL = "0";
    const { base } = project({ "a.ts": "x\n" });
    let loads = 0;
    const rt = runtime(base, { loadEmbedder: async () => { loads++; return crashyEmbedder({ loads: 0, crashes: 0 }); } });
    expect(rt.tier).toBe("cloud");
    expect(await rt.embedder()).toBeNull();
    expect(loads).toBe(0);
  });
});

describe("ONNX session limits", () => {
  test("documents capped at 1024 tokens and the CPU arena is off", () => {
    expect(MAX_DOC_TOKENS).toBe(1024);
    const src = readFileSync(path.join(__dirname, "../../src/core/tools/codeEmbed/embedder.ts"), "utf8");
    expect(src).toMatch(/enableCpuMemArena: false/);
    expect(src).not.toMatch(/node:worker_threads/);
  });
});


describe("chunker: no chunk over CHUNK_TOKENS, long lines included", () => {
  const count = (s: string) => Math.ceil(s.length / 3);
  test("minified one-line JS is split, not one 30k-token chunk", () => {
    const text = "var a=" + "function(x){return x*2},".repeat(4000) + "0;\n";
    const cs = chunkFile("app.min.js", text, count);
    expect(cs.length).toBeGreaterThan(1);
    expect(Math.max(...cs.map((c) => count(c.text)))).toBeLessThanOrEqual(CHUNK_TOKENS);
    expect(cs.every((c) => c.lineStart === 1 && c.lineEnd === 1)).toBe(true);
  });
  test("a long line in the middle of a normal file", () => {
    const text = "const a = 1;\n".repeat(50) + "x".repeat(20000) + "\n" + "const b = 2;\n".repeat(50);
    const cs = chunkFile("mixed.ts", text, count);
    expect(Math.max(...cs.map((c) => count(c.text)))).toBeLessThanOrEqual(CHUNK_TOKENS);
    expect(cs.at(-1)!.lineEnd).toBeGreaterThanOrEqual(101);
  });
  test("huge generated files stop at MAX_CHUNKS_PER_FILE", () => {
    const cs = chunkFile("bundle.js", "y".repeat(3_000_000), count);
    expect(cs.length).toBe(MAX_CHUNKS_PER_FILE);
  });
});

describe("status reports the device", () => {
  test("info() includes device facts and crash history", async () => {
    const { base } = project({ "a.ts": "x\n" });
    const rt = runtime(base);
    const i = rt.info();
    expect(i.device.ramGB).toBeGreaterThan(0);
    expect(i.device.cpu).toBeTruthy();
    expect(i.crashes).toEqual({ lastHour: 0, localDisabledUntil: null, quarantined: 0 });
  });
});
