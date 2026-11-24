/**
 * Index on touch (#1001): any tool naming an app/job adopts it; an edit in an un-indexed app adopts the app; apps
 * opened recently are indexed in the background; the user's git repos are opt-in once, tracked files only, never synced.
 */
import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
  detectRepoGrepCommand,
  repoConsentLine,
} from "../../src/core/tools/bash.js";
import {
  CODE_EMBED_DIM,
  l2normalize,
  type Embedder,
} from "../../src/core/tools/codeEmbed/embedder.js";
import {
  gitListFiles,
  isDataless,
  repoKey,
  repoRootFor,
} from "../../src/core/tools/codeEmbed/repos.js";
import { CodeEmbedRuntime } from "../../src/core/tools/codeEmbed/runtime.js";
import {
  recentAppRoots,
  touchTargetsFromArgs,
  wrapToolsWithIndexOnTouch,
} from "../../src/core/tools/codeEmbed/touch.js";

const WORDS = ["upload", "invoice", "auth", "retry", "graph"];
const fake = (): Embedder => {
  const vec = (t: string) => {
    const v = new Float32Array(CODE_EMBED_DIM).fill(0.001);
    WORDS.forEach((w, i) => {
      if (t.toLowerCase().includes(w)) v[i] = 1;
    });
    return l2normalize(v);
  };
  return {
    model: "papr-embed-code-1-0.6b",
    dim: CODE_EMBED_DIM,
    embedQuery: async (t: string) => vec(t),
    embedDocuments: async (ts: string[]) => ts.map(vec),
    countTokens: (s: string) => Math.ceil(s.length / 4),
    close: async () => {},
  } as unknown as Embedder;
};

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const J1 = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];
const rts: CodeEmbedRuntime[] = [];
afterEach(async () => {
  for (const r of rts.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const w = (root: string, rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};

function workFolder() {
  const papr = tmp("cetouch-");
  w(papr, `apps/${A1}/app.ts`, "export function upload(){ /* retry */ }\n");
  w(papr, `apps/${A2}/invoice.ts`, "export function renderInvoice(){}\n");
  w(papr, `Jobs/${J1}/run.py`, "def auth():\n    pass\n");
  return papr;
}

function runtime(
  papr: string,
  o: Partial<ConstructorParameters<typeof CodeEmbedRuntime>[0]> = {},
) {
  const rt = new CodeEmbedRuntime({
    dataDir: path.join(papr, "data"),
    cloud: async () => null,
    cloudAvailable: false,
    installed: () => true,
    loadEmbedder: async () => fake(),
    loadUpgrade: null,
    tierOverride: "local",
    canRun: () => true,
    paprRoot: papr,
    ...o,
  });
  rts.push(rt);
  return rt;
}

async function settle(rt: CodeEmbedRuntime) {
  await rt.embedder();
  for (let i = 0; i < 80 && rt.store.pendingBlobs().length; i++)
    await new Promise((r) => setTimeout(r, 25));
}

function gitRepo(
  files: Record<string, string>,
  untracked: Record<string, string> = {},
) {
  const repo = tmp("cerepo-");
  for (const [rel, body] of Object.entries(files)) w(repo, rel, body);
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("add", "-A");
  for (const [rel, body] of Object.entries(untracked)) w(repo, rel, body);
  return repo;
}

describe("index on touch: which tool calls name an app or job", () => {
  test("appId / jobId / projectId arguments and apps/<id> or Jobs/<id> paths", () => {
    const papr = workFolder();
    const roots = (args: unknown) =>
      touchTargetsFromArgs(args, papr)
        .filter((t) => t.kind === "project")
        .map((t) => path.relative(papr, t.value));
    expect(roots({ appId: A1, filename: "app.ts" })).toEqual([`apps/${A1}`]);
    expect(roots({ context: { appId: A2 } })).toEqual([`apps/${A2}`]); // older Mastra wrapping
    expect(roots({ jobId: J1 })).toEqual([`Jobs/${J1}`]);
    expect(roots({ projectId: J1 })).toEqual([`Jobs/${J1}`]);
    expect(
      roots({ path: path.join(papr, "apps", A1, "app.ts"), oldString: "x" }),
    ).toEqual([`apps/${A1}`]);
    expect(roots({ command: `grep -rn upload ${papr}/apps/${A2}/` })).toEqual([
      `apps/${A2}`,
    ]);
  });

  test("file contents are never scanned, unknown ids are ignored, at most 3 roots per call", () => {
    const papr = workFolder();
    expect(
      touchTargetsFromArgs(
        {
          path: "/x/y.ts",
          content: `see apps/${A1}/app.ts`,
          newString: `apps/${A2}/`,
        },
        papr,
      ).filter((t) => t.kind === "project"),
    ).toEqual([]);
    expect(
      touchTargetsFromArgs(
        { appId: "99999999-9999-4999-8999-999999999999" },
        papr,
      ),
    ).toEqual([]);
    expect(touchTargetsFromArgs("not an object", papr)).toEqual([]);
  });

  test("the wrapper returns the tool result unchanged, then notes the touch", async () => {
    const papr = workFolder();
    const seen: unknown[] = [];
    const tools = wrapToolsWithIndexOnTouch(
      {
        read_app_file: {
          id: "read_app_file",
          execute: async (i: any) => ({ success: true, data: i.filename }),
        },
      } as any,
      (t) => seen.push(...t),
      () => papr,
    );
    expect(
      await tools.read_app_file!.execute!({ appId: A1, filename: "app.ts" }),
    ).toEqual({ success: true, data: "app.ts" });
    expect(seen).toHaveLength(1);
  });

  test("a tool that throws still throws, and nothing is noted", async () => {
    const papr = workFolder();
    const seen: unknown[] = [];
    const tools = wrapToolsWithIndexOnTouch(
      {
        t: {
          execute: async () => {
            throw new Error("boom");
          },
        },
      } as any,
      (t) => seen.push(...t),
      () => papr,
    );
    await expect(tools.t!.execute!({ appId: A1 })).rejects.toThrow("boom");
    expect(seen).toEqual([]);
  });
});

describe("index on touch: the runtime adopts what was touched", () => {
  test("read_app_file on an un-indexed app indexes it in the background; search then finds it", async () => {
    const papr = workFolder();
    const rt = runtime(papr);
    const root = path.join(papr, "apps", A1);
    expect(rt.store.listFiles(root)).toEqual([]);
    rt.noteTouch(touchTargetsFromArgs({ appId: A1, filename: "app.ts" }, papr));
    expect(rt.store.listFiles(root).map((f) => f.path)).toEqual(["app.ts"]);
    await settle(rt);
    expect((await rt.search(root, "upload retry")).hits[0]?.path).toBe(
      "app.ts",
    );
  });

  test("an edit in an app that was never indexed adopts the whole app instead of being dropped", async () => {
    const papr = workFolder();
    const rt = runtime(papr);
    const root = path.join(papr, "apps", A2);
    w(papr, `apps/${A2}/upload.ts`, "export const upload = 1;\n");
    expect(rt.noteChange(path.join(root, "upload.ts"))).toBe(true);
    expect(
      rt.store
        .listFiles(root)
        .map((f) => f.path)
        .sort(),
    ).toEqual(["invoice.ts", "upload.ts"]);
  });

  test("off tier: touching is a no-op", () => {
    const papr = workFolder();
    const rt = runtime(papr, { tierOverride: "off" });
    rt.noteTouch(touchTargetsFromArgs({ appId: A1 }, papr));
    expect(rt.store.stats().files).toBe(0);
  });
});

describe("recent apps in the background", () => {
  test("apps opened in the last N days, most recent first, capped; others and missing folders skipped", () => {
    const papr = workFolder();
    const now = Date.parse("2026-11-23T12:00:00Z");
    w(
      papr,
      "data/apps.json",
      JSON.stringify([
        { id: A1, lastOpenedAt: "2026-11-20T00:00:00Z" },
        { id: A2, lastOpenedAt: "2026-11-22T00:00:00Z" },
        {
          id: "44444444-4444-4444-8444-444444444444",
          lastOpenedAt: "2026-11-22T00:00:00Z",
        }, // no folder
        { id: J1, lastOpenedAt: "2026-09-01T00:00:00Z" }, // too old
      ]),
    );
    expect(
      recentAppRoots(papr, 30, 50, now).map((r) => path.basename(r)),
    ).toEqual([A2, A1]);
    expect(
      recentAppRoots(papr, 30, 1, now).map((r) => path.basename(r)),
    ).toEqual([A2]);
    expect(recentAppRoots(papr, 0, 50, now)).toEqual([]);
  });

  test("warm() adopts recent apps", async () => {
    const papr = workFolder();
    w(
      papr,
      "data/apps.json",
      JSON.stringify([{ id: A2, lastOpenedAt: new Date().toISOString() }]),
    );
    const rt = runtime(papr);
    rt.warm();
    await settle(rt);
    expect(
      rt.store.listFiles(path.join(papr, "apps", A2)).map((f) => f.path),
    ).toEqual(["invoice.ts"]);
    expect(rt.store.listFiles(path.join(papr, "apps", A1))).toEqual([]);
  });
});

describe("the user's git repos: opt-in once", () => {
  test("repo root and consent key (shared across worktrees); never the Papr folder", () => {
    const repo = gitRepo({ "src/a.ts": "export const a = 1;\n" });
    expect(repoRootFor(path.join(repo, "src", "a.ts"))).toBe(repo);
    expect(repoKey(repo)).toMatch(/\.git$/);
    const papr = workFolder();
    execFileSync("git", ["-C", papr, "init", "-q"]);
    expect(repoRootFor(path.join(papr, "apps", A1), papr)).toBeUndefined();
  });

  test("only tracked files: untracked, node_modules, dot dirs and secrets are skipped", () => {
    const repo = gitRepo(
      {
        "src/graph.ts": "export function graph(){}\n",
        "node_modules/x/i.js": "x",
        ".env": "SECRET=1",
        "README.md": "# r\n",
        "img.png": "x",
      },
      { "src/scratch.ts": "export const untracked = 1;\n" },
    );
    expect(
      gitListFiles(repo)
        .map((f) => f.rel)
        .sort(),
    ).toEqual(["README.md", "src/graph.ts"]);
  });

  test("iCloud placeholders (size > 0, no blocks on disk) are never read", () => {
    expect(isDataless({ size: 10, blocks: 0 } as any)).toBe(
      process.platform === "darwin",
    );
    expect(isDataless({ size: 10, blocks: 8 } as any)).toBe(false);
  });

  test("undecided: not indexed; allow: indexed + found; deny: dropped and never asked again", async () => {
    const papr = workFolder();
    const repo = gitRepo({
      "src/graph.ts": "export function buildGraph(){ /* graph */ }\n",
      "src/auth.ts": "export function auth(){}\n",
    });
    const rt = runtime(papr);
    expect(rt.repoFor(repo)?.decision).toBeUndefined();
    rt.noteTouch([{ kind: "path", value: path.join(repo, "src", "graph.ts") }]);
    expect(rt.store.listFiles(repo)).toEqual([]); // touching an undecided repo indexes nothing

    expect(rt.setRepoConsent(path.join(repo, "src"), true)).toEqual({
      root: repo,
      allowed: true,
    });
    await settle(rt);
    expect((await rt.search(repo, "graph")).hits[0]?.path).toBe("src/graph.ts");

    // Consent survives a restart (a new runtime on the same data dir) and the repo is re-adopted by warm().
    await rt.close();
    const rt2 = runtime(papr);
    expect(rt2.repoFor(repo)?.decision).toBe("allow");
    rt2.warm();
    expect(rt2.info().repos).toBe(1);

    expect(rt2.setRepoConsent(repo, false)?.allowed).toBe(false);
    expect(rt2.store.listFiles(repo)).toEqual([]);
    expect(rt2.repoFor(repo)?.decision).toBe("deny");
    expect(
      JSON.parse(
        readFileSync(
          path.join(papr, "data", "code-embed", "repos.json"),
          "utf8",
        ),
      ).denied,
    ).toHaveLength(1);
  });

  test("repo vectors are never uploaded; an app's vectors still are", async () => {
    const papr = workFolder();
    const repo = gitRepo({ "src/graph.ts": "export function graph(){}\n" });
    const uploaded: string[] = [];
    const cloud = {
      post: async (p: string, o: { body: any }) => {
        if (p === "/v1/memory/code/missing")
          return { missing: o.body.blob_shas };
        if (p === "/v1/memory/batch") {
          o.body.memories.forEach((m: any) =>
            uploaded.push(m.code_context.path_hint),
          );
          return { total_successful: o.body.memories.length, total_failed: 0 };
        }
        return {};
      },
    };
    const rt = runtime(papr, {
      cloud: async () => cloud,
      cloudAvailable: true,
    });
    rt.setRepoConsent(repo, true);
    rt.noteTouch([{ kind: "project", value: path.join(papr, "apps", A1) }]);
    await settle(rt);
    await rt.indexer.syncCloud(() => "r");
    expect(uploaded).toEqual(["app.ts"]);
  });

  test("cloud-tier device: allowing a repo indexes nothing and sends nothing", async () => {
    const papr = workFolder();
    const repo = gitRepo({ "src/graph.ts": "export function graph(){}\n" });
    const posts: string[] = [];
    const rt = runtime(papr, {
      tierOverride: "cloud",
      cloudAvailable: true,
      cloud: async () => ({
        post: async (p: string) => {
          posts.push(p);
          return { missing: [] };
        },
      }),
      loadTokenCounter: async () => (s: string) => s.length,
    });
    rt.setRepoConsent(repo, true);
    await new Promise((r) => setTimeout(r, 100));
    expect(rt.store.listFiles(repo)).toEqual([]);
    expect(posts).toEqual([]);
  });
});

describe("grep in a repo", () => {
  test("detects plain grep / rg in a repo, not grep used as a filter", () => {
    expect(detectRepoGrepCommand(`grep -rn "buildGraph" src/`)).toEqual({
      pattern: "buildGraph",
      path: "src/",
    });
    expect(
      detectRepoGrepCommand(`rg -n --type ts upload ~/Developer/paprwork/src`),
    ).toEqual({ pattern: "upload", path: "~/Developer/paprwork/src" });
    expect(detectRepoGrepCommand(`grep -rn retry`)).toEqual({
      pattern: "retry",
      path: ".",
    });
    expect(detectRepoGrepCommand(`ps aux | grep node`)).toBeNull();
    expect(detectRepoGrepCommand(`git log | grep fix`)).toBeNull();
  });

  test("the consent line names the repo and the tool", () => {
    const l = repoConsentLine("/Users/x/Developer/paprwork");
    expect(l).toContain("/Users/x/Developer/paprwork");
    expect(l).toContain("code_index_repo");
    expect(existsSync).toBeTruthy();
  });
});
