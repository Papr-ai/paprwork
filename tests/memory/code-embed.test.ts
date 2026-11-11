/**
 * On-device code index: device tiers, content-addressed store, chunker, indexer (rename / edit / new file / delete),
 * cloud fallback and sync — with a fake embedder and a fake memory API, so no model download or network.
 */
import { mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { chunkFile, LONG_CHARS } from "../../src/core/tools/codeEmbed/chunker.js";
import { CodeIndexer, isIndexable } from "../../src/core/tools/codeEmbed/codeIndexer.js";
import { canRunNow, selfTestPasses, staticTier, type DeviceFacts } from "../../src/core/tools/codeEmbed/deviceHealth.js";
import { l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { CodeVectorStore, gitBlobSha } from "../../src/core/tools/codeEmbed/vectorStore.js";

const GB = 1024 ** 3;
const mac = (o: Partial<DeviceFacts> = {}): DeviceFacts => ({
  platform: "darwin", arch: "arm64", cpuModel: "Apple M2 Pro", physicalCores: 12, totalMemBytes: 16 * GB,
  freeMemBytes: 6 * GB, freeDiskBytes: 50 * GB, translated: false, ...o,
});

describe("device tiers", () => {
  test("Apple Silicon 16 GB is local", () => expect(staticTier(mac(), { cloudAvailable: true }).tier).toBe("local"));
  test("Intel Mac goes to cloud, or off when offline", () => {
    expect(staticTier(mac({ cpuModel: "Intel(R) Core(TM) i7", arch: "x64" }), { cloudAvailable: true }).tier).toBe("cloud");
    expect(staticTier(mac({ cpuModel: "Intel(R) Core(TM) i7", arch: "x64" }), { cloudAvailable: false }).tier).toBe("off");
  });
  test("base M1 8 GB is cloud; M1 Pro 16 GB is local", () => {
    expect(staticTier(mac({ cpuModel: "Apple M1", totalMemBytes: 8 * GB }), { cloudAvailable: true }).reasons).toContain("base M1 with under 16 GB");
    expect(staticTier(mac({ cpuModel: "Apple M1 Pro" }), { cloudAvailable: true }).tier).toBe("local");
  });
  test("Rosetta, emulated Windows, low RAM, low disk, few cores", () => {
    expect(staticTier(mac({ translated: true }), { cloudAvailable: true }).reasons).toContain("running under Rosetta");
    const win = { platform: "win32" as const, arch: "x64", cpuModel: "Snapdragon", physicalCores: 8, translated: true };
    expect(staticTier(mac(win), { cloudAvailable: true }).reasons).toContain("x64 build emulated on ARM");
    expect(staticTier(mac({ totalMemBytes: 6 * GB }), { cloudAvailable: true }).tier).toBe("cloud");
    expect(staticTier(mac({ freeDiskBytes: GB }), { cloudAvailable: true }).tier).toBe("cloud");
    expect(staticTier(mac({ platform: "linux", physicalCores: 2, cpuModel: "x" }), { cloudAvailable: true }).tier).toBe("cloud");
  });
  test("live gate and self-test", () => {
    expect(canRunNow({ freeMemBytes: GB }, false).ok).toBe(false);
    expect(canRunNow({ freeMemBytes: 4 * GB }, true).reason).toBe("battery saver");
    expect(canRunNow({ freeMemBytes: 4 * GB }, false).ok).toBe(true);
    expect(selfTestPasses(2500)).toBe(true);
    expect(selfTestPasses(9000)).toBe(false);
    expect(selfTestPasses(NaN)).toBe(false);
  });
});

describe("chunker + hashing", () => {
  test("gitBlobSha matches git for the empty blob", () => expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"));
  test("short file is one head chunk; long file gets overlapping line windows", () => {
    expect(chunkFile("a.ts", "const a = 1\n")).toHaveLength(1);
    expect(chunkFile("a.ts", "   \n")).toHaveLength(0);
    const long = Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i}; // padding padding`).join("\n");
    expect(long.length).toBeGreaterThan(LONG_CHARS);
    const ch = chunkFile("big.ts", long);
    expect(ch.length).toBeGreaterThan(2);
    expect(ch[1]!.text.startsWith("File: big.ts\n")).toBe(true);
    expect(ch[2]!.lineStart).toBeLessThan(ch[1]!.lineEnd); // overlap
    expect(ch.at(-1)!.lineEnd).toBe(4000);
  });
  test("secrets and big/binary-ish files are skipped", () => {
    expect(isIndexable(".env", 10)).toBe(false);
    expect(isIndexable("config/.env.local", 10)).toBe(false);
    expect(isIndexable("keys/server.pem", 10)).toBe(false);
    expect(isIndexable("src/a.ts", 10)).toBe(true);
    expect(isIndexable("src/a.ts", 1_000_000)).toBe(false);
    expect(isIndexable("img.png", 10)).toBe(false);
  });
});

/** Deterministic fake embedder: bag of 8 keywords -> unit vector in 8 dims (dim 8 store). */
const WORDS = ["alpha", "beta", "gamma", "delta", "retry", "upload", "render", "invoice"];
function fakeEmbedder(calls: string[] = []): Embedder {
  const vec = (t: string) => {
    const v = new Float32Array(8).fill(0.01);
    WORDS.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
    return l2normalize(v);
  };
  return {
    model: "test-8d", dim: 8,
    embedQuery: async (t) => vec(t),
    embedDocuments: async (ts) => { calls.push(...ts); return ts.map(vec); },
    countTokens: (s) => Math.ceil(s.length / 4),
    close: async () => {},
  };
}

function fakeCloud() {
  const calls: Array<{ path: string; body: any }> = [];
  const have = new Set<string>();
  const client = {
    post: async (p: string, o: { body: any }) => {
      calls.push({ path: p, body: o.body });
      if (p === "/v1/memory/code/missing") return { missing: o.body.blob_shas.filter((b: string) => !have.has(b)) };
      if (p === "/v1/memory/batch") { o.body.memories.forEach((m: any) => have.add(m.code_context.blob_sha)); return { total_successful: o.body.memories.length, total_failed: 0 }; }
      if (p === "/v1/memory/code/delete") { o.body.blob_shas.forEach((b: string) => have.delete(b)); return {}; }
      if (p === "/v1/memory/search")
        return { data: { memories: [...have].filter((b) => !o.body.code_search.blob_shas || o.body.code_search.blob_shas.includes(b)).map((b) => ({ id: b, customMetadata: { blob_sha: b, chunk: 0, line_start: 1, line_end: 3, score: 0.5 } })) } };
      return {};
    },
  };
  return { client, calls, have };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(tier: "local" | "cloud" | "off" = "local") {
  const dir = mkdtempSync(path.join(tmpdir(), "code-embed-"));
  dirs.push(dir);
  const root = path.join(dir, "app");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/retry.ts"), "export function retryUpload() { /* retry upload with backoff */ }\n");
  writeFileSync(path.join(root, "src/render.ts"), "export function renderInvoice() { /* render invoice */ }\n");
  writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  const store = CodeVectorStore.open(path.join(dir, "code-vectors.db"), "test-8d", 8);
  const docs: string[] = [];
  const emb = fakeEmbedder(docs);
  const cloud = fakeCloud();
  let t = tier;
  const ix = new CodeIndexer({ store, tier: () => t, embedder: async () => emb, cloud: async () => cloud.client });
  return { dir, root, store, ix, docs, cloud, setTier: (x: typeof t) => (t = x) };
}

describe("CodeIndexer", () => {
  test("refresh -> pending -> embed -> search finds the right file with lines", async () => {
    const { root, store, ix } = setup();
    expect(ix.refresh(root).changed.sort()).toEqual(["src/render.ts", "src/retry.ts"]);
    expect(store.stats().pending).toBe(2);
    expect((await ix.embedPending()).embedded).toBe(2);
    expect(store.stats().pending).toBe(0);
    const { tier, hits } = await ix.search("where do we retry the upload", { root });
    expect(tier).toBe("local");
    expect(hits[0]).toMatchObject({ path: "src/retry.ts", lineStart: 1 });
  });

  test("rename keeps the vector: no re-embed, search returns the new path", async () => {
    const { root, ix, docs } = setup();
    ix.refresh(root); await ix.embedPending();
    const before = docs.length;
    renameSync(path.join(root, "src/retry.ts"), path.join(root, "src/net-retry.ts"));
    const r = ix.refresh(root);
    expect(r.removed).toEqual(["src/retry.ts"]);
    expect((await ix.embedPending()).embedded).toBe(0);
    expect(docs.length).toBe(before);
    expect((await ix.search("retry upload", { root })).hits[0]!.path).toBe("src/net-retry.ts");
  });

  test("edited file is pending and its stale vector is not returned", async () => {
    const { root, store, ix } = setup();
    ix.refresh(root); await ix.embedPending();
    writeFileSync(path.join(root, "src/retry.ts"), "export const gammaDelta = 1\n");
    ix.noteWrite(root, path.join(root, "src/retry.ts")); // agent write hook: pending without a rescan
    expect(store.stats().pending).toBe(1);
    const hits = (await ix.search("retry upload", { root })).hits;
    expect(hits.find((h) => h.path === "src/retry.ts")).toBeUndefined();
    await ix.embedPending();
    expect((await ix.search("gamma delta", { root })).hits[0]!.path).toBe("src/retry.ts");
  });

  test("new file is found after one background tick", async () => {
    const { root, ix } = setup();
    ix.refresh(root); await ix.embedPending();
    writeFileSync(path.join(root, "src/beta.ts"), "export const beta = 'beta alpha'\n");
    ix.noteWrite(root, path.join(root, "src/beta.ts"));
    expect((await ix.embedPending()).embedded).toBe(1);
    expect((await ix.search("alpha beta", { root })).hits[0]!.path).toBe("src/beta.ts");
  });

  test("never indexes .env", async () => {
    const { root, store, ix } = setup();
    ix.refresh(root);
    expect(store.listFiles(root).map((f) => f.path)).not.toContain(".env");
  });

  test("duplicate content in two paths is embedded once and returns both paths", async () => {
    const { root, ix, docs } = setup();
    writeFileSync(path.join(root, "src/copy.ts"), "export function retryUpload() { /* retry upload with backoff */ }\n");
    ix.refresh(root); await ix.embedPending();
    expect(docs.filter((d) => d.includes("retryUpload"))).toHaveLength(1);
    const paths = (await ix.search("retry upload", { root, limit: 5 })).hits.map((h) => h.path);
    expect(paths).toEqual(expect.arrayContaining(["src/retry.ts", "src/copy.ts"]));
  });

  test("cloud sync uploads only missing blobs, vectors only, then deletes orphans", async () => {
    const { root, ix, cloud } = setup();
    ix.refresh(root); await ix.embedPending();
    const r1 = await ix.syncCloud(() => "repo-1");
    expect(r1.uploaded).toBe(2);
    const batch = cloud.calls.find((c) => c.path === "/v1/memory/batch")!.body.memories;
    expect(batch[0].code_context.embedding).toHaveLength(8);
    expect(batch[0].code_context.store_content).toBe(false);
    expect(batch[0].content).toMatch(/^code:[0-9a-f]{40}:0$/); // no source text uploaded
    expect((await ix.syncCloud(() => "repo-1")).uploaded).toBe(0); // idempotent
    unlinkSync(path.join(root, "src/render.ts"));
    ix.refresh(root);
    const r3 = await ix.syncCloud(() => "repo-1");
    expect(r3.dropped).toBe(1);
    expect(cloud.have.size).toBe(1);
  });

  test("cloud tier: no local model, server search restricted to this device's blobs, mapped to current paths", async () => {
    const { root, ix, setTier, cloud } = setup();
    ix.refresh(root); await ix.embedPending(); await ix.syncCloud(() => "r");
    setTier("cloud");
    expect((await ix.embedPending()).skipped).toBe("tier cloud");
    renameSync(path.join(root, "src/render.ts"), path.join(root, "src/view.ts"));
    ix.refresh(root);
    const { tier, hits } = await ix.search("render invoice", { root });
    expect(tier).toBe("cloud");
    expect(hits.map((h) => h.path)).toContain("src/view.ts");
    const sent = cloud.calls.filter((c) => c.path === "/v1/memory/search").at(-1)!.body.code_search;
    expect(sent.query_embedding).toBeUndefined();
    expect(sent.blob_shas).toHaveLength(2);
  });

  test("off tier and cloud failure return no hits instead of throwing", async () => {
    const { root, ix, setTier } = setup();
    ix.refresh(root);
    setTier("off");
    expect(await ix.search("x", { root })).toEqual({ tier: "off", hits: [] });
    const broken = new CodeIndexer({
      store: (ix as any).d.store, tier: () => "cloud", embedder: async () => null,
      cloud: async () => ({ post: async () => { throw new Error("offline"); } }),
    });
    expect((await broken.search("x", { root })).hits).toEqual([]);
  });

  test("dimension mismatch is rejected", () => {
    const { store } = setup();
    expect(() => store.putChunks([{ blobSha: "a".repeat(40), chunk: 0, lineStart: 1, lineEnd: 1, vec: new Float32Array(4), source: "local" }])).toThrow(/dims/);
  });
});
