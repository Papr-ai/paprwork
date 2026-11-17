import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { buildRerankRequest, jevRerank, snippetFor, type JevCaller } from "../../src/core/tools/codeJevRerank.js";
import { clearCorpusCache, codePointerBlock } from "../../src/core/tools/codeSearchV2.js";

const cands = [
  { path: "docs/readme.md", snippet: "how saving works" },
  { path: "src/store.ts", snippet: "export function saveUser(u) { db.insert(u) }" },
  { path: "src/ui.ts", snippet: "button.onclick = () => saveUser(form)" },
];
/** Fake Jev: prefers the file whose snippet defines the function. */
const fakeJev: JevCaller = async ({ state, questions }) => {
  const c = state.candidates as Record<string, string>;
  return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: /function saveUser/.test(c[k]!) ? 0.9 : /saveUser/.test(c[k]!) ? 0.4 : 0.05 }])) };
};

describe("Jev reranker", () => {
  afterEach(() => { delete process.env.PAPR_CODE_JEV_RERANK; });

  test("request: one noul question per candidate, user request included, capped at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, snippet: "x" }));
    const { state, questions } = buildRerankRequest({ candidates: many, userRequest: " fix saving ", query: "saveUser", command: "grep -rn saveUser ." });
    expect(Object.keys(questions)).toHaveLength(20);
    expect(questions.c0!.type).toBe("noul");
    expect(state.user_request).toBe("fix saving");
    expect(Object.keys(state.candidates as object)).toHaveLength(20);
  });

  test("orders candidates by Jev probability", async () => {
    const r = await jevRerank({ candidates: cands, query: "saveUser", command: "grep saveUser" }, fakeJev);
    expect(r!.map((x) => x.path)).toEqual(["src/store.ts", "src/ui.ts", "docs/readme.md"]);
  });

  test("falls back (null) when Jev throws, is slow, or answers badly", async () => {
    const q = { candidates: cands, query: "q", command: "grep q" };
    expect(await jevRerank(q, async () => { throw new Error("offline"); })).toBeNull();
    expect(await jevRerank(q, () => new Promise((r) => setTimeout(() => r({ answers: {} }), 500)), 50)).toBeNull();
    expect(await jevRerank(q, async () => ({ answers: { c0: { noul: 0.5 } } }))).toBeNull();
  });

  test("flag PAPR_CODE_JEV_RERANK=0 turns it off", async () => {
    process.env.PAPR_CODE_JEV_RERANK = "0";
    expect(await jevRerank({ candidates: cands, query: "q", command: "c" }, fakeJev)).toBeNull();
  });

  test("snippet uses the matched chunk lines", () => {
    expect(snippetFor("a\nb\nc\nd", { lineStart: 2, lineEnd: 3 })).toBe("b\nc");
    expect(snippetFor("abc")).toBe("abc");
  });
});

describe("codePointerBlock with Jev", () => {
  const root = mkdtempSync(path.join(tmpdir(), "jev-rr-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/store.ts"), "export function saveUser(u) {\n  db.insert(u);\n}\n");
  writeFileSync(path.join(root, "src/ui.ts"), "import { saveUser } from './store';\nbutton.onclick = () => saveUser(form);\n");
  writeFileSync(path.join(root, "src/other.ts"), "export const unrelated = 1;\n");
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const base = { projectRoot: root, query: "where users are saved", command: "grep -rn persist .", pattern: "persist" };
  // Semantic order puts the wrong file first; Jev should lift the defining file.
  const memoryHits = [{ path: "src/other.ts", score: 0.9 }, { path: "src/ui.ts", score: 0.8 }, { path: "src/store.ts", score: 0.7 }];

  test("Jev order leads and is labelled", async () => {
    clearCorpusCache();
    const out = await codePointerBlock({ ...base, memoryHits, jevCall: fakeJev, userRequest: "saving a user fails" });
    expect(out).toMatch(/ranked by Jev/);
    const first = out.split("\n")[1]!;
    expect(first).toMatch(/^src\/store\.ts/);
    expect(first).toMatch(/Jev 0\.90/);
  });

  test("Jev failure keeps the formula output unchanged", async () => {
    clearCorpusCache();
    const fallback = await codePointerBlock({ ...base, memoryHits, jevCall: async () => { throw new Error("offline"); } });
    process.env.PAPR_CODE_JEV_RERANK = "0";
    clearCorpusCache();
    const formula = await codePointerBlock({ ...base, memoryHits });
    delete process.env.PAPR_CODE_JEV_RERANK;
    expect(fallback).toBe(formula);
    expect(fallback).not.toMatch(/Jev/);
  });

  test("no semantic hits: still nothing, Jev not called", async () => {
    let called = false;
    const out = await codePointerBlock({ ...base, memoryHits: [], jevCall: async () => { called = true; return { answers: {} }; } });
    expect(out).toBe("");
    expect(called).toBe(false);
  });
});
