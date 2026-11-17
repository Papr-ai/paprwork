import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterAll, describe, expect, test } from "vitest";
import {
  Repo,
  candidates,
  fuseRanked,
  SOURCE_WEIGHT,
  toks,
} from "../../src/core/tools/codeCandidates.js";
import {
  clearCorpusCache,
  codePointerBlock,
  rankPointers,
} from "../../src/core/tools/codeSearchV2.js";
import { grepHitFiles } from "../../src/core/tools/codeSearchGrepHits.js";
import type { SourceFile } from "../../src/core/tools/codeFusion.js";

// Shapes of the Curation Bench misses papr-embed alone could not reach (q275, r105, r6, r77).
const FILES: SourceFile[] = [
  {
    path: "index.html",
    text: '<script src="demo-api-shim.js"></script>\n<script src="app.js"></script>\n',
  },
  {
    path: "demo-api-shim.js",
    text: "fetch('demo-focus.json').then((r) => r.json());\n",
  },
  { path: "demo-focus.json", text: '{"focus": []}\n' },
  {
    path: "app.js",
    text: "function renderSection(s) {\n  return s;\n}\nrenderSection(demos);\n",
  },
  {
    path: "db-queries.js",
    text: 'const q = "SELECT * FROM demos WHERE published = 1";\n',
  },
  { path: "routes.py", text: "from demos import handler\nimport os\n" },
  {
    path: "connector-room.js",
    text: "db.query(`SELECT vc_intro_paths, why_fund FROM intro_pathways`);\n",
  },
  { path: "docs/notes.md", text: "The shim lives in demo-api-shim.js.\n" },
  {
    path: "workspace/entities/companies/taisu-ventures.md",
    text: "# Taisu Ventures\nYuna Tian, partner.\n",
  },
  { path: "workspace/entities/people/yuna-tian.md", text: "# Yuna Tian\n" },
];
const repo = new Repo(FILES);

describe("papr-code-search v2 candidates", () => {
  test("tokenizer splits camelCase and drops stop words", () => {
    // "section"/"data" are stop words (same list as the evaluated Python candgen.py)
    expect(toks("renderSection in the data room")).toEqual(["render", "room"]);
  });

  test("bm25 finds exact names papr-embed misses", () => {
    expect(repo.bm25("intro_pathways vc_intro_paths", 3)[0]).toBe(
      "connector-room.js",
    );
  });

  test("anchor + load: the file named in the command and what it loads", () => {
    const c = candidates(
      repo,
      [],
      "sed -n 1,40p index.html",
      "focus experience demo",
      [],
    );
    // A file keeps the first source that found it (bm25 runs first), as in the replay that set the weights.
    expect(c.some((x) => x.path === "index.html")).toBe(true);
    expect(c.some((x) => x.path === "demo-api-shim.js")).toBe(true);
    expect(repo.loads("demo-api-shim.js")).toContain("demo-focus.json");
  });

  test("table edges come from SQL lines only, not Python imports", () => {
    expect([...(repo.tables.get("demos") ?? [])]).toEqual(["db-queries.js"]);
    expect(repo.tables.get("demos")?.has("routes.py")).toBe(false);
  });

  test("entity pages match names used in the search", () => {
    const c = candidates(
      repo,
      [],
      "grep -r Taisu .",
      "what does the doc say about Taisu",
      [],
    );
    expect(
      c.some(
        (x) =>
          x.path.endsWith("taisu-ventures.md") &&
          (x.source === "entity" || x.source === "bm25"),
      ),
    ).toBe(true);
  });

  test("fusion keeps the papr-embed order when no source adds anything", () => {
    const dense = ["a.ts", "b.ts", "c.ts"];
    expect(fuseRanked(dense, [], 3).map((r) => r.path)).toEqual(dense);
  });

  test("fusion: a file found by dense AND a source outranks dense-only neighbours", () => {
    const dense = ["x.ts", "y.ts", "z.ts"];
    const r = fuseRanked(dense, [{ path: "z.ts", source: "anchor" }], 3);
    expect(r[0].path).toBe("z.ts");
    expect(r[0].sources).toEqual(["dense", "anchor"]);
    expect(SOURCE_WEIGHT.dense).toBe(1);
  });
});

describe("papr-code-search v2 ranking", () => {
  test("memory hits are re-ranked by the graph; sources only add files memory did not return", () => {
    const { pointers, alsoCheck } = rankPointers(FILES, repo, {
      memoryHits: [
        { path: "db-queries.js", score: 0.9 },
        { path: "app.js", score: 0.5 },
      ],
      query: "renderSection",
      command: "sed -n 1,40p index.html",
      pattern: "renderSection",
    });
    // the graph attaches the definition (line range + symbol) to the memory hit that defines it
    const app = pointers.find((p) => p.path === "app.js");
    expect(app?.def?.name).toBe("renderSection");
    expect(app?.why.join(" ")).toContain("defines renderSection");
    expect(alsoCheck.length).toBeLessThanOrEqual(2);
    expect(alsoCheck.map((a) => a.path)).not.toContain("app.js");
    expect(alsoCheck.map((a) => a.path)).not.toContain("db-queries.js");
    expect(
      alsoCheck.some(
        (a) => a.path === "index.html" || a.path === "demo-api-shim.js",
      ),
    ).toBe(true);
  });

  test("files grep already printed are not repeated", () => {
    const { pointers, alsoCheck } = rankPointers(FILES, repo, {
      memoryHits: [{ path: "app.js", score: 0.9 }],
      query: "render demo section",
      command: "grep -rn renderSection .",
      pattern: "renderSection",
      grepHits: ["app.js"],
    });
    expect([...pointers, ...alsoCheck].map((t) => t.path)).not.toContain(
      "app.js",
    );
  });

  test("grepHitFiles parses grep -rn output", () => {
    expect(
      grepHitFiles(
        "./app.js:4:renderSection(demos)\n/abs/db-queries.js:1:SELECT\nbinary file matches",
      ),
    ).toEqual(["app.js", "/abs/db-queries.js"]);
  });
});

describe("codePointerBlock (filesystem)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pcs2-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    clearCorpusCache();
  });
  for (const f of FILES.filter((f) => !f.path.startsWith("workspace/"))) {
    mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    writeFileSync(path.join(dir, f.path), f.text);
  }
  mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(
    path.join(dir, "node_modules", "pkg", "renderSection.js"),
    "function renderSection() {}\n",
  );

  test("no memory hits -> no block (sources alone were mostly noise in the replay)", async () => {
    expect(
      await codePointerBlock({
        projectRoot: dir,
        memoryHits: [],
        query: "x",
        command: "grep -rn intro_pathways .",
        pattern: "intro_pathways",
      }),
    ).toBe("");
  });

  test("returns a pointer block with also-check files and skips node_modules", async () => {
    const block = await codePointerBlock({
      projectRoot: dir,
      memoryHits: [{ path: "app.js", score: 0.8 }],
      query: "query or read intro_pathways table",
      command: "grep -rn intro_pathways .",
      pattern: "intro_pathways",
    });
    expect(block).toContain("papr-code-search v2");
    expect(block).toContain("app.js");
    expect(block).toContain("also check");
    expect(block).toContain("connector-room.js");
    expect(block).not.toContain("node_modules");
  });

  test("fails closed on a missing root", async () => {
    expect(
      await codePointerBlock({
        projectRoot: path.join(dir, "nope"),
        memoryHits: [],
        query: "x",
        command: "grep x",
        pattern: "x",
      }),
    ).toBe("");
  });
});
