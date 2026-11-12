import { describe, expect, test } from "vitest";
import {
  Links,
  extractDefinitions,
  fuse,
  fuseProject,
  importEdges,
  isReexport,
  textSymbols,
  type SourceFile,
} from "../../src/core/tools/codeFusion.js";

const FILES: SourceFile[] = [
  {
    path: "src/routes/write/topics.js",
    text: "const controllers = require('../../controllers');\nmodule.exports = function () { route('post', controllers.write.topics.create); };\n",
  },
  { path: "src/controllers/index.js", text: "'use strict';\nexports.write = require('./write');\nexports.api = require('./api');\n" },
  { path: "src/controllers/write/index.js", text: "'use strict';\nconst Write = module.exports;\nWrite.topics = require('./topics');\n" },
  {
    path: "src/controllers/write/topics.js",
    text: "const api = require('../../api');\nconst Topics = module.exports;\nTopics.create = async (req, res) => {\n  await api.topics.create(req);\n};\n",
  },
  { path: "src/controllers/api.js", text: "module.exports = {};\n" },
  { path: "test/topics.js", text: "require('../src/controllers/write/topics');\n" },
];
const links = () =>
  new Links(importEdges(FILES), new Set(FILES.filter((f) => isReexport(f.path, f.text)).map((f) => f.path)));

describe("code fusion (papr-code-harness v1.1)", () => {
  test("import edges resolve relative and index files", () => {
    const e = importEdges(FILES);
    expect(e.get("src/routes/write/topics.js")?.has("src/controllers/index.js")).toBe(true);
    expect(e.get("src/controllers/index.js")?.has("src/controllers/write/index.js")).toBe(true);
  });

  test("re-export detection", () => {
    expect(isReexport("src/controllers/index.js", FILES[1].text)).toBe(true);
    expect(isReexport("a/__init__.py", "from .x import y\n__all__ = ['y']\n")).toBe(true);
    expect(isReexport("src/controllers/write/topics.js", FILES[3].text)).toBe(false);
  });

  test("links pass through re-exports and skip tests", () => {
    const L = links();
    const ns = L.of("src/routes/write/topics.js");
    expect(ns.has("src/controllers/write/topics.js")).toBe(true);
    expect(ns.has("src/controllers/index.js")).toBe(false);
    expect(L.of("src/controllers/write/topics.js").has("test/topics.js")).toBe(false);
  });

  test("text symbols", () => {
    const s = textSymbols("Calling `Posts.getSummary()` with sortedSetCount fails; also delete_from_disk. This should work.");
    for (const x of ["getSummary", "sortedSetCount", "delete_from_disk"]) expect(s.has(x)).toBe(true);
    expect(s.has("should")).toBe(false);
  });

  test("definitions for JS, TS, Python and Go with line ranges", () => {
    const d = extractDefinitions([
      { path: "a.js", text: "Topics.create = async (req) => {\n  x();\n};\nfunction plain() {\n}\n" },
      { path: "b.ts", text: "export class Store {\n  load(id: string): void {\n  }\n}\n" },
      { path: "c.py", text: "class A:\n    def run(self):\n        return 1\n\ndef top():\n    pass\n" },
      { path: "d.go", text: "func (s *Server) Login(u string) error {\n\treturn nil\n}\n" },
    ]);
    expect(d.get("create")?.[0]).toMatchObject({ path: "a.js", l0: 1, l1: 3 });
    expect(d.get("plain")?.[0]).toMatchObject({ l0: 4, l1: 5 });
    expect(d.get("Store")?.[0]).toMatchObject({ path: "b.ts", l0: 1, l1: 4 });
    expect(d.get("load")?.[0]).toMatchObject({ l0: 2, l1: 3 });
    expect(d.get("run")?.[0]).toMatchObject({ path: "c.py", l0: 2, l1: 3 });
    expect(d.get("Login")?.[0]).toMatchObject({ path: "d.go", l0: 1, l1: 3 });
  });

  test("a link lifts the controller papr-embed missed; re-exports never rank", () => {
    const dense = new Map([
      ["src/routes/write/topics.js", 0.8],
      ["src/controllers/index.js", 0.79],
      ["src/controllers/api.js", 0.7],
    ]);
    const top = fuse(dense, extractDefinitions(FILES), links(), []).map((h) => h.path);
    expect(top.slice(0, 3)).toContain("src/controllers/write/topics.js");
    expect(top).not.toContain("src/controllers/index.js");
  });

  test("the file defining a named symbol beats its area neighbour and points at the function", () => {
    const files: SourceFile[] = [
      { path: "db/sorted.js", text: "module.exports.sortedSetCount = function () {\n  return 1;\n};\n" },
      { path: "db/sorted/union.js", text: "const s = require('../sorted');\nmodule.exports.u = function () {};\n" },
    ];
    const dense = new Map([
      ["db/sorted/union.js", 0.8],
      ["db/sorted.js", 0.72],
      ["other.js", 0.6],
    ]);
    const top = fuseProject(files, dense, "sortedSetCount is wrong");
    expect(top[0].path).toBe("db/sorted.js");
    expect(top[0].def).toMatchObject({ name: "sortedSetCount", l0: 1, l1: 3 });
    expect(top[0].why.join(" ")).toContain("defines sortedSetCount");
  });

  test("names defined in many files carry no signal", () => {
    const files: SourceFile[] = Array.from({ length: 5 }, (_, i) => ({ path: `m${i}.py`, text: "def reset():\n    pass\n" }));
    const top = fuseProject(files, new Map([["m0.py", 0.5], ["m1.py", 0.4]]), "reset_all calls reset");
    expect(top.every((h) => !h.def)).toBe(true);
  });
});

describe("fusedPointers (hybrid grep wiring)", () => {
  test("re-ranks memory hits for a real project dir and returns line-ranged pointers", async () => {
    const fs = await import("fs/promises");
    const os = await import("os");
    const p = await import("path");
    const root = await fs.mkdtemp(p.join(os.tmpdir(), "fusion-"));
    const write = async (rel: string, text: string) => {
      await fs.mkdir(p.dirname(p.join(root, rel)), { recursive: true });
      await fs.writeFile(p.join(root, rel), text);
    };
    await write("db/sorted.ts", "export function sortedSetCount(key: string): number {\n  return 1;\n}\n");
    await write("db/sorted/union.ts", "import { sortedSetCount } from '../sorted';\nexport function union() {\n  return sortedSetCount('x');\n}\n");
    await write("db/other.ts", "export const other = 1;\n");
    await write("db/sorted.test.ts", "export function sortedSetCount() {}\n");
    await write("node_modules/x/index.js", "function sortedSetCount() {}\n");
    const { fusedPointers } = await import("../../src/core/tools/codeFusion.js");
    const out = await fusedPointers(
      root,
      [
        { path: p.join(root, "db/sorted/union.ts"), score: 0.8 },
        { path: "db/sorted.ts", score: 0.72 },
        { path: "db/other.ts", score: 0.6 },
        { path: "missing.ts", score: 0.9 },
      ],
      'Find Papr mini-apps code related to "sortedSetCount".',
    );
    const lines = out.trim().split("\n");
    expect(lines[0]).toContain("Code pointers");
    expect(lines[1]).toMatch(/^db\/sorted\.ts:1-3 {2}sortedSetCount {2}\(.*defines sortedSetCount/);
    expect(out).not.toContain("test.ts");
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain("missing.ts");
    expect(await fusedPointers(root, [], "q")).toBe("");
    await fs.rm(root, { recursive: true, force: true });
  });
});
