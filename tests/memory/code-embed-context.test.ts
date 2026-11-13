/**
 * The Papr Work folder's non-code context in the on-device index: documents/, workspace/, repos/<name>/.
 * Adopted at startup (no grep needed), documents/ versions and meta.json skipped, edits picked up from the watcher hook,
 * a new repo adopted on its first change, and grep paths under these folders resolve to their root.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { detectPaprContextGrepCommand, detectPaprGrepCommand } from "../../src/core/tools/bash.js";
import { contextRootFor, contextRoots } from "../../src/core/tools/codeEmbed/contextRoots.js";
import { CODE_EMBED_DIM, l2normalize, type Embedder } from "../../src/core/tools/codeEmbed/embedder.js";
import { CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";

const WORDS = ["pricing", "investor", "brand", "graph", "invoice"];
const fake = (): Embedder => {
  const vec = (t: string) => {
    const v = new Float32Array(CODE_EMBED_DIM).fill(0.001);
    WORDS.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
    return l2normalize(v);
  };
  return { model: "papr-embed-code-1-0.6b", dim: CODE_EMBED_DIM, embedQuery: async (t) => vec(t), embedDocuments: async (ts) => ts.map(vec), countTokens: (s) => Math.ceil(s.length / 4), close: async () => {} } as Embedder;
};

const dirs: string[] = [];
const rts: CodeEmbedRuntime[] = [];
afterEach(async () => {
  for (const r of rts.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workFolder() {
  const papr = mkdtempSync(path.join(tmpdir(), "cectx-"));
  dirs.push(papr);
  const w = (rel: string, body: string) => { mkdirSync(path.dirname(path.join(papr, rel)), { recursive: true }); writeFileSync(path.join(papr, rel), body); };
  w("documents/pricing-plan/content.md", "# Pricing\nPro is $20 per seat.\n");
  w("documents/pricing-plan/meta.json", '{"title":"pricing"}');
  w("documents/pricing-plan/versions/v1.md", "# Pricing (old)\n");
  w("workspace/entities/acme.md", "# Acme\nInvestor, passed in Nov.\n");
  w("workspace/BRAND.md", "# Brand\nLiquid glass.\n");
  w("repos/papr-graph-native/graph.py", "def build_graph():\n    pass\n");
  w("repos/papr-graph-native/.env", "SECRET=1");
  w("apps/11111111-2222-3333-4444-555555555555/app.ts", "export const invoice = 1;\n");
  return papr;
}

function runtime(papr: string) {
  const rt = new CodeEmbedRuntime({ dataDir: path.join(papr, "data"), cloud: async () => null, cloudAvailable: false, installed: () => true, loadEmbedder: async () => fake(), loadUpgrade: null, tierOverride: "local", canRun: () => true, paprRoot: papr });
  rts.push(rt);
  return rt;
}

async function settle(rt: CodeEmbedRuntime) {
  await rt.embedder();
  for (let i = 0; i < 60 && rt.store.pendingBlobs().length; i++) await new Promise((r) => setTimeout(r, 50));
}

describe("Papr Work folder context in the on-device index", () => {
  test("roots: documents, workspace and each repo; apps/Jobs are not context roots", () => {
    const papr = workFolder();
    expect(contextRoots(papr).map((r) => path.relative(papr, r)).sort()).toEqual(["documents", "repos/papr-graph-native", "workspace"]);
  });

  test("warm() indexes them at startup, skipping versions/, meta.json and secrets", async () => {
    const papr = workFolder();
    const rt = runtime(papr);
    rt.warm();
    await settle(rt);
    const files = (r: string) => rt.store.listFiles(path.join(papr, r)).map((f) => f.path).sort();
    expect(files("documents")).toEqual(["pricing-plan/content.md"]);
    expect(files("workspace")).toEqual(["BRAND.md", "entities/acme.md"]);
    expect(files("repos/papr-graph-native")).toEqual(["graph.py"]);
    const hits = await rt.search(path.join(papr, "documents"), "pricing per seat");
    expect(hits.hits[0]!.path).toBe("pricing-plan/content.md");
  });

  test("watcher hook: an edited workspace note is re-embedded; a new repo is adopted on its first change", async () => {
    const papr = workFolder();
    const rt = runtime(papr);
    rt.warm();
    await settle(rt);
    writeFileSync(path.join(papr, "workspace/entities/acme.md"), "# Acme\nThey build a graph database.\n");
    expect(rt.noteChange(path.join(papr, "workspace/entities/acme.md"))).toBe(true);
    await settle(rt);
    expect((await rt.search(path.join(papr, "workspace"), "graph database")).hits[0]!.path).toBe("entities/acme.md");
    mkdirSync(path.join(papr, "repos/new-repo"), { recursive: true });
    writeFileSync(path.join(papr, "repos/new-repo/invoice.ts"), "export function invoice() {}\n");
    expect(rt.noteChange(path.join(papr, "repos/new-repo/invoice.ts"))).toBe(true);
    await settle(rt);
    expect(rt.store.listFiles(path.join(papr, "repos/new-repo")).map((f) => f.path)).toEqual(["invoice.ts"]);
    expect(rt.noteChange(path.join(papr, "documents/pricing-plan/versions/v2.md"))).toBe(false);
  });

  test("off switch: PAPR_CODE_EMBED_CONTEXT=0 adopts nothing", async () => {
    const papr = workFolder();
    process.env.PAPR_CODE_EMBED_CONTEXT = "0";
    try {
      const rt = runtime(papr);
      rt.warm();
      expect(rt.contextRoots()).toEqual([]);
    } finally {
      delete process.env.PAPR_CODE_EMBED_CONTEXT;
    }
  });

  test("grep paths resolve to their context root", () => {
    const papr = "/Users/x/Papr/orgs/o/namespaces/n";
    expect(contextRootFor(`${papr}/documents/pricing-plan`, papr)).toBe(`${papr}/documents`);
    expect(contextRootFor(`-rn ${papr}/workspace/entities`, papr)).toBe(`${papr}/workspace`);
    expect(contextRootFor(`$PAPR_HOME/repos/papr-graph-native/src`, papr)).toBe(`${papr}/repos/papr-graph-native`);
    expect(contextRootFor(`${papr}/repos`, papr)).toBeUndefined();
    expect(contextRootFor(`${papr}/apps/x`, papr)).toBeUndefined();
    const cmd = `grep -rn "investor" ${papr}/workspace/entities`;
    expect(detectPaprGrepCommand(cmd)).toBeNull();
    expect(detectPaprContextGrepCommand(cmd)).toEqual({ pattern: "investor", path: `${papr}/workspace/entities` });
    expect(detectPaprContextGrepCommand(`grep -rn foo ${papr}/apps/abc`)).toBeNull();
    expect(detectPaprContextGrepCommand(`grep foo /tmp/documents`)).toBeNull();
  });
});
