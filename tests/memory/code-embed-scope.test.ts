/**
 * Org isolation for the on-device code index: one index per org + namespace, pinned on first open; no cloud calls once
 * the active workspace changes; greps in another org's folder get nothing.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { CODE_EMBED_DIM, l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { CodeEmbedRuntime, isForeignWorkspacePath } from "../../src/core/tools/codeEmbed/runtime.js";
import { CodeVectorStore } from "../../src/core/tools/codeEmbed/vectorStore.js";

const fake = (): Embedder =>
  ({ model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM, embedQuery: async () => l2normalize(new Float32Array(CODE_EMBED_DIM).fill(1)), embedDocuments: async (ts: string[]) => ts.map(() => l2normalize(new Float32Array(CODE_EMBED_DIM).fill(1))), countTokens: (s: string) => Math.ceil(s.length / 4), close: async () => {} }) as unknown as Embedder;

const dirs: string[] = [];
const rts: CodeEmbedRuntime[] = [];
afterEach(async () => {
  for (const r of rts.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), "cescope-")); dirs.push(d); return d; };

function runtime(dataDir: string, scope: string, active: () => string | null, calls: string[]) {
  const rt = new CodeEmbedRuntime({
    dataDir, scope, activeScope: active, cloudAvailable: true, installed: () => true, loadEmbedder: async () => fake(), loadUpgrade: null, tierOverride: "cloud", canRun: () => true,
    cloud: async () => ({ post: async (p: string) => { calls.push(p); return { data: { memories: [] }, missing: [] }; } }),
  });
  rts.push(rt);
  return rt;
}

describe("code index org isolation", () => {
  test("an index is pinned to the org+namespace that first opened it", () => {
    const db = path.join(tmp(), "index.db");
    const a = CodeVectorStore.open(db, "m", 4);
    a.bindScope("org:A|ns:1");
    a.bindScope("org:A|ns:1");
    a.close();
    const b = CodeVectorStore.open(db, "m", 4);
    expect(() => b.bindScope("org:B|ns:1")).toThrow(/belongs to org:A\|ns:1/);
    expect(() => b.bindScope("org:A|ns:2")).toThrow();
    b.close();
  });

  test("runtime refuses to open another org's index", () => {
    const dir = tmp();
    const calls: string[] = [];
    runtime(dir, "org:A|ns:1", () => "org:A|ns:1", calls);
    expect(() => runtime(dir, "org:B|ns:1", () => "org:B|ns:1", calls)).toThrow();
  });

  test("no cloud call once the active workspace is a different org", async () => {
    let active = "org:A|ns:1";
    const calls: string[] = [];
    const rt = runtime(tmp(), "org:A|ns:1", () => active, calls);
    await rt.indexer.search("q", { root: "/x" });
    expect(calls).toEqual(["/v1/memory/search"]);
    active = "org:B|ns:9";
    calls.length = 0;
    expect((await rt.indexer.search("q", { root: "/x" })).hits).toEqual([]);
    expect(await rt.indexer.syncCloud(() => "r")).toEqual({ uploaded: 0, failed: 0, dropped: 0 });
    expect(calls).toEqual([]);
  });

  test("grep paths in another org or namespace are foreign", () => {
    const active = "/Users/x/Papr/orgs/ORG_A/namespaces/NS1";
    expect(isForeignWorkspacePath(`${active}/apps/abc`, active)).toBe(false);
    expect(isForeignWorkspacePath("/Users/x/Papr/orgs/ORG_B/namespaces/NS1/apps/abc", active)).toBe(true);
    expect(isForeignWorkspacePath("/Users/x/Papr/orgs/ORG_A/namespaces/NS2/documents", active)).toBe(true);
    expect(isForeignWorkspacePath("/Users/x/Developer/repo", active)).toBe(false);
    expect(isForeignWorkspacePath("/Users/x/Papr/orgs/ORG_A/namespaces/NS1/workspace", "/Users/x/Papr")).toBe(true);
  });
});
