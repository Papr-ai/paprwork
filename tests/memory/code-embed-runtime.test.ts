/**
 * The on-device code index wired into the agent's grep: background indexing, Neural Engine/ONNX embedder (faked here),
 * the 2 s budget, cloud tier, edits picked up on the next search, and the merge into the pointer ranking.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { deviceHitsBlock, mergeDeviceHits } from "../../src/core/tools/bash.js";
import { CODE_EMBED_DIM, l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";

const WORDS = ["retry", "upload", "render", "invoice", "auth", "token"];
function fakeEmbedder(opts: { slowMs?: number; name?: string } = {}): Embedder {
  const vec = (t: string) => {
    const v = new Float32Array(CODE_EMBED_DIM).fill(0.001);
    WORDS.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
    return l2normalize(v);
  };
  const e = {
    model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM,
    embedQuery: async (t: string) => { if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs)); return vec(t); },
    embedDocuments: async (ts: string[]) => ts.map(vec),
    countTokens: (s: string) => Math.ceil(s.length / 4),
    close: async () => {},
  };
  if (opts.name) Object.defineProperty(e, "constructor", { value: { name: opts.name } });
  return e;
}

const dirs: string[] = [];
const rts: CodeEmbedRuntime[] = [];
afterEach(async () => {
  for (const r of rts.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project() {
  const base = mkdtempSync(path.join(tmpdir(), "cer-"));
  dirs.push(base);
  const root = path.join(base, "apps", "11111111-2222-3333-4444-555555555555");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "upload.ts"), "export async function upload(f){ /* retry with backoff */ }\n");
  writeFileSync(path.join(root, "src", "invoice.ts"), "export function renderInvoice(){ return '<div/>' }\n");
  writeFileSync(path.join(root, "src", "auth.ts"), "export function refreshToken(){ /* auth */ }\n");
  return { base, root };
}

function runtime(base: string, o: Partial<ConstructorParameters<typeof CodeEmbedRuntime>[0]> = {}) {
  const rt = new CodeEmbedRuntime({
    dataDir: path.join(base, "data"), cloud: async () => null, cloudAvailable: false,
    installed: () => true, loadEmbedder: async () => fakeEmbedder({ name: "OnnxEmbedder" }),
    loadUpgrade: async () => { await new Promise((r) => setTimeout(r, 100)); return fakeEmbedder({ name: "CoreMLEmbedder" }); },
    tierOverride: "local", canRun: () => true, ...o,
  });
  rts.push(rt);
  return rt;
}

async function settle(rt: CodeEmbedRuntime, root: string) {
  await rt.embedder();
  for (let i = 0; i < 40 && rt.store.pendingBlobs(root).length; i++) await new Promise((r) => setTimeout(r, 50));
}

describe("code embed runtime (agent grep path)", () => {
  test("first search returns [] immediately, starts load + background index; later searches rank on device", async () => {
    const { base, root } = project();
    const rt = runtime(base);
    const t = Date.now();
    expect((await rt.search(root, "retry upload")).hits).toEqual([]);
    expect(Date.now() - t).toBeLessThan(500);
    await settle(rt, root);
    await new Promise((r) => setTimeout(r, 150));
    expect(rt.backend).toBe("CoreMLEmbedder");
    const r = await rt.search(root, "retry upload");
    expect(r.tier).toBe("local");
    expect(r.hits[0]!.path).toBe("src/upload.ts");
    expect(r.hits.map((h) => h.path)).toContain("src/auth.ts");
  });

  test("indexing starts on ONNX while the Neural Engine is still loading, then switches over", async () => {
    const { base, root } = project();
    let release!: () => void;
    const rt = runtime(base, { loadUpgrade: () => new Promise((ok) => { release = () => ok(fakeEmbedder({ name: "CoreMLEmbedder" })); }) });
    await rt.search(root, "x");
    await settle(rt, root);
    expect(rt.backend).toBe("OnnxEmbedder");
    expect(rt.store.pendingBlobs(root)).toHaveLength(0);
    expect((await rt.search(root, "retry upload")).hits[0]!.path).toBe("src/upload.ts");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.backend).toBe("CoreMLEmbedder");
    expect((await rt.search(root, "retry upload")).hits[0]!.path).toBe("src/upload.ts");
  });

  test("Neural Engine load failure: stays on ONNX", async () => {
    const { base, root } = project();
    const rt = runtime(base, { loadUpgrade: async () => { throw new Error("coreml helper load timeout"); } });
    await rt.search(root, "x");
    await settle(rt, root);
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.backend).toBe("OnnxEmbedder");
    expect((await rt.search(root, "invoice")).hits[0]!.path).toBe("src/invoice.ts");
  });

  test("an edited file is re-embedded and found by its new content", async () => {
    const { base, root } = project();
    const rt = runtime(base);
    await rt.search(root, "x");
    await settle(rt, root);
    writeFileSync(path.join(root, "src", "auth.ts"), "export function render(){ /* invoice pdf */ }\n");
    rt.touch(root, true);
    await settle(rt, root);
    const r = await rt.search(root, "invoice render");
    expect(r.hits.slice(0, 2).map((h) => h.path).sort()).toEqual(["src/auth.ts", "src/invoice.ts"]);
  });

  test("model not installed: download starts in the background, search still returns at once", async () => {
    const { base, root } = project();
    let downloads = 0;
    const rt = runtime(base, { installed: () => false, download: async () => { downloads++; await new Promise((r) => setTimeout(r, 200)); } });
    const t = Date.now();
    expect((await rt.search(root, "retry")).hits).toEqual([]);
    expect(Date.now() - t).toBeLessThan(300);
    expect(downloads).toBe(1);
    expect(rt.status).toBe("downloading model");
  });

  test("a slow device fails the self-test and drops to cloud (or off)", async () => {
    const { base, root } = project();
    const rt = runtime(base, { loadEmbedder: async () => fakeEmbedder({ slowMs: 600 }), cloudAvailable: true });
    await rt.search(root, "x");
    expect(await rt.embedder()).toBeNull();
    expect(rt.tier).toBe("cloud");
    expect(rt.tierReasons[0]).toMatch(/self-test too slow/);
  }, 15_000);

  test("search honours the time budget", async () => {
    const { base, root } = project();
    const rt = runtime(base);
    await rt.search(root, "x");
    await settle(rt, root);
    (rt as any).emb = fakeEmbedder({ slowMs: 1500 });
    const t = Date.now();
    expect((await rt.search(root, "retry", { budgetMs: 200 })).hits).toEqual([]);
    expect(Date.now() - t).toBeLessThan(600);
  });

  test("cloud tier: query goes to Papr Memory code_search, restricted to this root's blobs", async () => {
    const { base, root } = project();
    const calls: any[] = [];
    const cloud = { post: async (p: string, o: { body: any }) => {
      calls.push({ p, body: o.body });
      const sha = o.body.code_search?.blob_shas?.[0];
      return { data: { memories: sha ? [{ score: 0.9, customMetadata: { blob_sha: sha, chunk: 0, line_start: 1, line_end: 1, score: 0.9 } }] : [] } };
    } };
    const rt = runtime(base, { tierOverride: "cloud", cloud: async () => cloud, cloudAvailable: true });
    const r = await rt.search(root, "retry upload");
    expect(r.tier).toBe("cloud");
    expect(calls[0]!.p).toBe("/v1/memory/search");
    expect(calls[0]!.body.code_search.blob_shas).toHaveLength(3);
    expect(r.hits).toHaveLength(1);
  });

  test("off tier (no model, no cloud): [] and grep carries on", async () => {
    const { base, root } = project();
    const rt = runtime(base, { tierOverride: "off" });
    expect(await rt.search(root, "retry")).toEqual({ tier: "off", hits: [] });
  });
});

test("available memory on macOS counts reclaimable pages, not just free", async () => {
  const { availableMemBytes } = await import("../../src/core/tools/codeEmbed/deviceHealth.js");
  const os = await import("os");
  expect(availableMemBytes()).toBeGreaterThanOrEqual(os.freemem());
});

test("project id is the one after apps/ or Jobs/, not an earlier UUID in the path", async () => {
  const { projectIdFromPath } = await import("../../src/core/tools/codeEmbed/runtime.js");
  const app = "0e6b0e6b-1111-4222-8333-444455556666";
  expect(projectIdFromPath(`/tmp/papr-vitest-1-c1460b5e-7885-42a9-b801-d554add9535d/Papr/apps/${app}`)).toBe(app);
  expect(projectIdFromPath(`/Users/x/Papr/Jobs/${app}/code/main.py`)).toBe(app);
  expect(projectIdFromPath(`C:\\Users\\x\\Papr\\apps\\${app}\\src`)).toBe(app);
  expect(projectIdFromPath("/Users/x/Papr/apps")).toBeUndefined();
});

test("grep detection keeps the whole quoted phrase (not just its first word)", async () => {
  const { detectPaprGrepCommand } = await import("../../src/core/tools/bash.js");
  const dir = "/Users/x/Papr/apps/0e6b0e6b-1111-4222-8333-444455556666";
  expect(detectPaprGrepCommand(`grep -rn "generate a pdf for an order" ${dir}`)).toEqual({ pattern: "generate a pdf for an order", path: dir });
  expect(detectPaprGrepCommand(`grep -rn 'retry upload' ${dir}`)?.pattern).toBe("retry upload");
  expect(detectPaprGrepCommand(`grep -rn reconcileRefunds ${dir}`)?.pattern).toBe("reconcileRefunds");
  expect(detectPaprGrepCommand(`grep -rn foo /tmp/elsewhere`)).toBeNull();
});

test("a hybrid grep with no literal match still succeeds (exit 1 is not an error) so semantic results reach the agent", async () => {
  const fs = await import("fs");
  const { getPaprAppsRoot } = await import("../../src/core/utils/paprRoot.js");
  const dir = path.join(getPaprAppsRoot(), "0e6b0e6b-2222-4222-8333-444455556666");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n");
  process.env.PAPR_CODE_EMBED = "0";
  try {
    const { executeBashCommand } = await import("../../src/core/tools/bash.js");
    const none: any = await executeBashCommand({ command: `grep -rn "no such phrase anywhere" ${dir}` } as any);
    expect(none.success).toBe(true);
    expect(none.data.exitCode).toBe(1);
    const bad: any = await executeBashCommand({ command: `grep -rn foo ${dir}/missing-file.ts` } as any);
    expect(bad.success).toBe(false); // exit 2 (real error) still fails
  } finally {
    delete process.env.PAPR_CODE_EMBED;
  }
});

describe("merge into the pointer ranking", () => {
  test("device hits lead, memory hits not already present follow below them", () => {
    const merged = mergeDeviceHits(
      [{ path: "src/upload.ts", score: 0.7, lineStart: 1, lineEnd: 9 }, { path: "src/auth.ts", score: 0.5, lineStart: 1, lineEnd: 3 }],
      [{ path: "/Users/x/Papr/apps/id/src/auth.ts", score: 0.99 }, { path: "/Users/x/Papr/apps/id/src/db.ts", score: 0.98 }],
    );
    expect(merged.map((m) => m.path)).toEqual(["src/upload.ts", "src/auth.ts", "/Users/x/Papr/apps/id/src/db.ts"]);
    expect(merged[2]!.score).toBeLessThan(0.5);
  });
  test("block names the backend", () => {
    const b = deviceHitsBlock({ tier: "local", backend: "CoreMLEmbedder", hits: [{ path: "a.ts", score: 0.61234, lineStart: 1, lineEnd: 20 }] });
    expect(b).toContain("Neural Engine");
    expect(b).toContain("a.ts:1-20  (0.612)");
  });
});

describe("model provisioning (new and existing installs)", () => {
  const body = (b: Buffer) => new Response(new Uint8Array(b));
  const spec = (b: Buffer) => ({ size: b.length, sha256: require("crypto").createHash("sha256").update(b).digest("hex") });
  const files = { "onnx/model_quantized.onnx": Buffer.from("x".repeat(5000)), "tokenizer.json": Buffer.from("{\"t\":1}"), "tokenizer_config.json": Buffer.from("{}") };
  const manifest = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, spec(v)]));

  test("downloads the pinned revision, verifies hashes, and resumes a partial file with Range", async () => {
    const { downloadModel, modelInstalled, modelDir, HF_REVISION } = await import("../../src/core/tools/codeEmbed/embedder.js");
    const base = mkdtempSync(path.join(tmpdir(), "cem-")); dirs.push(base);
    const partial = path.join(modelDir(base), "onnx/model_quantized.onnx.part");
    mkdirSync(path.dirname(partial), { recursive: true });
    writeFileSync(partial, files["onnx/model_quantized.onnx"].subarray(0, 1200));
    const calls: Array<{ url: string; range?: string }> = [];
    const fetchImpl = (async (url: string, init?: any) => {
      const f = Object.keys(files).find((k) => url.endsWith("/" + k))! as keyof typeof files;
      const range = init?.headers?.Range as string | undefined;
      calls.push({ url, range });
      if (range) { const from = Number(range.slice(6, -1)); return new Response(new Uint8Array(files[f].subarray(from)), { status: 206 }); }
      return body(files[f]);
    }) as any;
    await downloadModel(base, fetchImpl, { coreml: false, manifest });
    expect(modelInstalled(base)).toBe(false); // test manifest differs from the real sizes; check files directly
    for (const [k, v] of Object.entries(files)) expect(require("fs").readFileSync(path.join(modelDir(base), k))).toEqual(v);
    expect(calls.every((c) => c.url.includes(`/resolve/${HF_REVISION}/`))).toBe(true);
    expect(calls.find((c) => c.url.endsWith("model_quantized.onnx"))?.range).toBe("bytes=1200-");
  });

  test("a corrupted download is deleted and never installed", async () => {
    const { downloadModel, modelDir } = await import("../../src/core/tools/codeEmbed/embedder.js");
    const base = mkdtempSync(path.join(tmpdir(), "cem-")); dirs.push(base);
    const bad = (async (url: string) => body(url.endsWith("tokenizer.json") ? Buffer.from("{\"t\":2}") : files[Object.keys(files).find((k) => url.endsWith("/" + k)) as keyof typeof files])) as any;
    await expect(downloadModel(base, bad, { coreml: false, manifest })).rejects.toThrow(/tokenizer.json: hash/);
    const fs = require("fs");
    expect(fs.existsSync(path.join(modelDir(base), "tokenizer.json"))).toBe(false);
    expect(fs.existsSync(path.join(modelDir(base), "tokenizer.json.part"))).toBe(false);
  });

  test("restart: warm() re-adopts roots indexed before, without waiting for a grep", async () => {
    const { base, root } = project();
    const a = runtime(base); a.touch(root, true); await settle(a, root); await a.close(); rts.splice(rts.indexOf(a), 1);
    const b = runtime(base);
    expect(b.info().roots).toBe(0);
    b.warm();
    await b.embedder();
    expect(b.info().roots).toBe(1);
    expect(b.info().chunks).toBeGreaterThan(0);
  });

  test("a changed README/summary is re-embedded from the watcher hook; data/ and dot dirs are ignored", async () => {
    const { base, root } = project();
    const rt = runtime(base); rt.touch(root, true); await settle(rt, root);
    writeFileSync(path.join(root, "README.md"), "# Invoice rendering\nHow invoices are rendered to html.\n");
    expect(rt.noteChange(path.join(root, "README.md"))).toBe(true);
    await settle(rt, root);
    const r = await rt.search(root, "invoice render docs", { limit: 5 });
    expect(r.hits.map((h) => h.path)).toContain("README.md");
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(path.join(root, "data", "x.md"), "invoice");
    expect(rt.noteChange(path.join(root, "data", "x.md"))).toBe(false);
    expect(rt.noteChange("/elsewhere/file.ts")).toBe(false);
  });
});
