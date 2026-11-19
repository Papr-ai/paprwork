/**
 * Interruptions while indexing and syncing (issue #912): app quit or restart mid-embed, the Mac sleeping or losing
 * power, network drops mid-sync, signed out / offline, files deleted then restored, and the Neural Engine helper
 * failing to load or dying. Fake embedders and a fake memory API: no model, no network.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { chunkZeroLast } from "../../src/core/tools/codeEmbed/cloudSync.js";
import { CODE_EMBED_DIM, l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";
import { gitBlobSha } from "../../src/core/tools/codeEmbed/vectorStore.js";

type Fake = Embedder & { isolated?: boolean; onExit?: (l: () => void) => void; die?: () => void; name: string };
function fake(name: string, o: { isolated?: boolean; docs?: (ts: string[]) => Promise<void> } = {}): Fake {
  const listeners: Array<() => void> = [];
  const vec = (t: string) => { const v = new Float32Array(CODE_EMBED_DIM).fill(0.001); v[t.length % 8] = 1; return l2normalize(v); };
  const e: Fake = {
    name, model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM, isolated: o.isolated,
    embedQuery: async (t) => vec(t),
    embedDocuments: async (ts) => { await o.docs?.(ts); return ts.map(vec); },
    countTokens: (s) => Math.ceil(s.length / 4),
    close: async () => {},
    onExit: (l) => listeners.push(l),
    die: () => listeners.forEach((l) => l()),
  };
  Object.defineProperty(e, "constructor", { value: { name } });
  return e;
}

/** Memory's code API as the server behaves: a blob counts as present once its chunk 0 is stored. */
function fakeCloud() {
  const points = new Set<string>(); // blob:chunk
  const calls: string[] = [];
  let failBatch = -1; // fail the Nth /batch call (0-based), once
  let batches = 0;
  let down = false;
  const client = {
    post: async (p: string, o: { body: any }) => {
      calls.push(p);
      if (down) throw new Error("ECONNRESET");
      if (p === "/v1/memory/code/missing") return { missing: o.body.blob_shas.filter((b: string) => !points.has(`${b}:0`)) };
      if (p === "/v1/memory/batch") {
        if (batches++ === failBatch) throw new Error("socket hang up");
        for (const m of o.body.memories) points.add(`${m.code_context.blob_sha}:${m.code_context.chunk}`);
        return { total_successful: o.body.memories.length, total_failed: 0 };
      }
      if (p === "/v1/memory/code/delete") { for (const b of o.body.blob_shas) for (const k of [...points]) if (k.startsWith(`${b}:`)) points.delete(k); return {}; }
      return {};
    },
  };
  return { client, points, calls, failNext: (n: number) => { failBatch = batches + n; }, setDown: (d: boolean) => { down = d; } };
}

const dirs: string[] = [];
const rts: CodeEmbedRuntime[] = [];
afterEach(async () => {
  delete process.env.PAPR_CODE_EMBED_CLOUD_SYNC;
  for (const r of rts.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>) {
  const base = mkdtempSync(path.join(tmpdir(), "cers-"));
  dirs.push(base);
  const root = path.join(base, "apps", "11111111-2222-3333-4444-555555555555");
  mkdirSync(root, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(root, f), t);
  return { base, root };
}

function runtime(base: string, o: Partial<ConstructorParameters<typeof CodeEmbedRuntime>[0]> = {}) {
  const rt = new CodeEmbedRuntime({
    dataDir: path.join(base, "data"), cloud: async () => null, cloudAvailable: true, installed: () => true,
    loadEmbedder: async () => fake("WorkerOnnxEmbedder", { isolated: true }), loadUpgrade: null,
    tierOverride: "local", canRun: () => true, ...o,
  });
  rts.push(rt);
  return rt;
}
const drop = async (rt: CodeEmbedRuntime) => { await rt.close(); rts.splice(rts.indexOf(rt), 1); };
const until = async (f: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !f(); t += 20) await new Promise((r) => setTimeout(r, 20)); };
const big = (n: number) => Array.from({ length: n }, (_, i) => `export function f${i}(a, b) { return a + b + ${i}; } // padding padding padding`).join("\n");

describe("app quit / restart while embedding", () => {
  test("quitting mid-embed does not count against the file or the device, and it embeds after restart", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    let release!: () => void;
    const rt = runtime(base, { loadEmbedder: async () => fake("WorkerOnnxEmbedder", { isolated: true, docs: () => new Promise((r) => { release = r; }) }) });
    rt.touch(root, true);
    await rt.embedder();
    const run = rt.indexer.embedPending(4);
    await until(() => !!release);
    await drop(rt); // app quits while the embed is out
    release();
    expect((await run).skipped).toBe("stopped");
    const next = runtime(base);
    expect(next.store.quarantined(1).size).toBe(0);
    expect((next as any).crashTimes()).toHaveLength(0);
    next.touch(root, true);
    await next.embedder();
    await until(() => next.store.pendingBlobs(root).length === 0);
    expect(next.store.stats().chunks).toBe(1);
  });

  test("force-quit / power loss mid-embed in the child process: next start is not a crash and the file is retried", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    const sha = gitBlobSha(readFileSync(path.join(root, "a.ts")));
    for (let i = 0; i < 3; i++) {
      const rt = runtime(base);
      rt.touch(root, true);
      rt.store.setInflight(sha, { isolated: true }); // what a SIGKILL of the whole app leaves behind
      (rt as any).closed = true; rt.indexer.stop(); (rt as any).store.close(); rts.splice(rts.indexOf(rt), 1); // no clean close
    }
    const next = runtime(base);
    expect(next.tier).toBe("local");
    expect(next.store.quarantined(1).has(sha)).toBe(false);
    expect(next.indexer.localPending()).toContain(sha);
  });

  test("an in-process embedder left in flight still counts (the old crash rule is kept)", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    const sha = gitBlobSha(readFileSync(path.join(root, "a.ts")));
    const rt = runtime(base);
    rt.touch(root, true);
    rt.store.setInflight(sha);
    (rt as any).store.close(); rts.splice(rts.indexOf(rt), 1);
    const next = runtime(base);
    expect(next.store.quarantined(1).has(sha)).toBe(true);
  });
});

describe("cloud sync interrupted", () => {
  /** Tests that drive syncCloud by hand: keep the runtime's own background sync out of the way. */
  const manual = () => { process.env.PAPR_CODE_EMBED_CLOUD_SYNC = "0"; };
  test("upload cut off between batches: chunk 0 goes last, so the blob is resent and completes", async () => {
    manual();
    const { base, root } = project({ "big.ts": big(400) });
    const cloud = fakeCloud();
    const rt = runtime(base, { cloud: async () => cloud.client });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0);
    const sha = rt.store.listFiles(root)[0]!.blobSha;
    const chunks = rt.store.stats().chunks;
    expect(chunks).toBeGreaterThan(2);
    cloud.failNext(1); // first batch lands, second drops
    const r1 = await rt.indexer.syncCloud(() => "r", { batch: 2 });
    expect(r1.failed).toBeGreaterThan(0);
    expect(cloud.points.has(`${sha}:0`)).toBe(false); // looks missing, not half-done
    await rt.indexer.syncCloud(() => "r", { batch: 2 });
    expect([...cloud.points].filter((k) => k.startsWith(sha)).length).toBe(chunks);
  });

  test("chunkZeroLast keeps blobs together with chunk 0 at the end", () => {
    const rows = [["a", 0], ["a", 1], ["b", 0], ["a", 2], ["b", 1]] as Array<[string, number]>;
    expect(chunkZeroLast(rows, (r) => r[0], (r) => r[1])).toEqual([["a", 1], ["a", 2], ["a", 0], ["b", 1], ["b", 0]]);
  });

  test("signed out / offline: deletes are queued, survive a restart, and are sent once online", async () => {
    manual();
    const { base, root } = project({ "a.ts": "export const a = 1\n", "b.ts": "export const b = 2\n" });
    const cloud = fakeCloud();
    let online = true;
    const rt = runtime(base, { cloud: async () => (online ? cloud.client : null) });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0);
    await rt.indexer.syncCloud(() => "r");
    const b = gitBlobSha(readFileSync(path.join(root, "b.ts")));
    expect(cloud.points.has(`${b}:0`)).toBe(true);
    online = false;
    unlinkSync(path.join(root, "b.ts"));
    rt.indexer.refresh(root);
    expect((await rt.indexer.syncCloud(() => "r")).dropped).toBe(1);
    expect(rt.store.pendingCloudDeletes()).toEqual([b]);
    await drop(rt); // restart while offline
    const next = runtime(base, { cloud: async () => cloud.client });
    expect(next.store.pendingCloudDeletes()).toEqual([b]);
    await next.indexer.syncCloud(() => "r");
    expect(cloud.points.has(`${b}:0`)).toBe(false);
    expect(next.store.pendingCloudDeletes()).toEqual([]);
  });

  test("a delete that fails on the network stays queued and is retried", async () => {
    manual();
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    const cloud = fakeCloud();
    const rt = runtime(base, { cloud: async () => cloud.client });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0);
    await rt.indexer.syncCloud(() => "r");
    unlinkSync(path.join(root, "a.ts"));
    rt.indexer.refresh(root);
    cloud.setDown(true);
    expect((await rt.indexer.syncCloud(() => "r")).failed).toBe(-1);
    expect(rt.store.pendingCloudDeletes()).toHaveLength(1);
    cloud.setDown(false);
    await rt.indexer.syncCloud(() => "r");
    expect(rt.store.pendingCloudDeletes()).toEqual([]);
    expect(cloud.points.size).toBe(0);
  });

  test("a file restored before its queued delete runs is not deleted from the cloud", async () => {
    manual();
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    const cloud = fakeCloud();
    let online = true;
    const rt = runtime(base, { cloud: async () => (online ? cloud.client : null) });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0);
    await rt.indexer.syncCloud(() => "r");
    const text = readFileSync(path.join(root, "a.ts"), "utf8");
    online = false;
    unlinkSync(path.join(root, "a.ts"));
    rt.indexer.refresh(root);
    await rt.indexer.syncCloud(() => "r");
    writeFileSync(path.join(root, "a.ts"), text); // git checkout / undo
    rt.indexer.refresh(root);
    online = true;
    await rt.indexer.syncCloud(() => "r");
    expect(cloud.calls).not.toContain("/v1/memory/code/delete");
    expect(rt.store.pendingCloudDeletes()).toEqual([]);
  });

  test("restart reconciles with the cloud once, without waiting for an edit or a grep", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    const rt = runtime(base, { cloud: async () => null });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0);
    await drop(rt); // indexed while signed out, then the app restarts signed in
    const cloud = fakeCloud();
    const next = runtime(base, { cloud: async () => cloud.client });
    next.warm();
    await until(() => cloud.points.size > 0);
    expect(cloud.points.size).toBe(1);
  });

  test("a failed sync leaves the loop scheduled instead of stopping", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    const cloud = fakeCloud();
    cloud.setDown(true);
    const rt = runtime(base, { cloud: async () => cloud.client });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.store.pendingBlobs(root).length === 0 && cloud.calls.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect((rt as any).syncDirty).toBe(true);
    expect((rt as any).loop).not.toBeNull();
  });
});

describe("Neural Engine helper", () => {
  test("a failed load is retried with backoff instead of staying on ONNX all session", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    let tries = 0;
    const rt = runtime(base, {
      upgradeRetryMs: 20,
      loadUpgrade: async () => { if (++tries === 1) throw new Error("missing papr-embed-coreml"); return fake("CoreMLEmbedder", { isolated: true }); },
    });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => (rt as any).upgradeNote !== null);
    expect(rt.info().upgrade).toMatch(/missing papr-embed-coreml/);
    await until(() => rt.backend === "CoreMLEmbedder");
    expect(tries).toBe(2);
    expect(rt.info().upgrade).toBeNull();
  });

  test("the helper dying hands back to ONNX at once, then the Neural Engine is reloaded", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    const ups: Fake[] = [];
    const rt = runtime(base, { upgradeRetryMs: 20, loadUpgrade: async () => { const u = fake("CoreMLEmbedder", { isolated: true }); ups.push(u); return u; } });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => rt.backend === "CoreMLEmbedder");
    ups[0]!.die!();
    expect(rt.backend).toBe("WorkerOnnxEmbedder");
    expect((await rt.search(root, "a")).tier).toBe("local");
    await until(() => ups.length === 2 && rt.backend === "CoreMLEmbedder");
    expect(ups).toHaveLength(2);
  });

  test("close() during a pending Neural Engine retry stops it", async () => {
    const { base, root } = project({ "a.ts": "export const a = 1\n" });
    let tries = 0;
    const rt = runtime(base, { upgradeRetryMs: 30, loadUpgrade: async () => { tries++; throw new Error("nope"); } });
    rt.touch(root, true);
    await rt.embedder();
    await until(() => tries === 1);
    await drop(rt);
    await new Promise((r) => setTimeout(r, 120));
    expect(tries).toBe(1);
  });
});
