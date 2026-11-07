import { describe, expect, test } from "vitest";
import {
  buildGateRequest,
  filterCandidates,
  formatPointerBlock,
  gateCandidates,
  grepHitFiles,
  isRepoWideSearch,
  type HookCandidate,
} from "../../src/core/tools/grepHook.js";

describe("grep hook", () => {
  test("detects repo-wide searches only", () => {
    for (const c of [
      'grep -rn "copyAppFiles" src',
      "cd ~/Developer/paprwork && grep -R foo .",
      "rg TextChoices",
      "git grep -n alter_db_table",
      "find . -name '*.ts' | xargs grep -l useOllama",
      'grep -rln "compact\\|compress" src/gateway/services/agent | head -20',
    ]) expect(isRepoWideSearch(c), c).toBe(true);
    for (const c of [
      'grep -n "def split_exclude" query.py',
      "pip list | grep django",
      "cat app.ts | grep fetch",
      "sed -n 1,40p a.ts",
      "ls -la",
    ]) expect(isRepoWideSearch(c), c).toBe(false);
  });

  test("parses files from grep output", () => {
    const out = "src/a/b.ts:12:  x\n./src/c.tsx-3-  y\ntests/d.test.ts:1:z\nBinary file e matches";
    expect(grepHitFiles(out)).toEqual(["src/a/b.ts", "src/c.tsx", "tests/d.test.ts"]);
  });

  const cands: HookCandidate[] = [
    { id: "c1", path: "src/gateway/services/appFiles/installCopy.ts", l0: 40, l1: 88, symbol: "copyInstalledFiles", why: "matches install" },
    { id: "c2", path: "tests/app-files.test.ts", why: "test" },
    { id: "c3", path: "src/gateway/services/appFiles/AppFilesService.ts", l0: 60, l1: 80, why: "already in grep" },
    { id: "c4", path: "src/gateway/routes/install.ts", l0: 10, l1: 30, symbol: "installRoute", why: "calls copyInstalledFiles" },
  ];

  test("drops tests/docs and files grep already showed", () => {
    const kept = filterCandidates(cands, ["./src/gateway/services/appFiles/AppFilesService.ts".replace("./", "")]);
    expect(kept.map((c) => c.id)).toEqual(["c1", "c4"]);
  });

  test("gate keeps confident candidates, max 3, and shows nothing when Jev is down", () => {
    const kept = filterCandidates(cands, []);
    expect(gateCandidates(kept, { c1: 0.9, c3: 0.2, c4: 0.6 }).map((c) => c.id)).toEqual(["c1", "c4"]);
    expect(gateCandidates(kept, null)).toEqual([]);
  });

  test("gate request has one noul question per candidate", () => {
    const r = buildGateRequest("how are app files copied on install", cands.slice(0, 2));
    expect(Object.keys(r.questions)).toEqual(["c1", "c2"]);
    expect(r.questions.c1.type).toBe("noul");
    expect(r.state.candidates.c1).toContain("installCopy.ts:40-88");
  });

  test("formats pointers after grep output and flags test-heavy results", () => {
    const block = formatPointerBlock([{ ...cands[0], p: 0.9 }], ["tests/a.test.ts", "tests/b.test.ts", "src/x.ts"]);
    expect(block).toContain("--- papr: code this search may have missed");
    expect(block).toContain("src/gateway/services/appFiles/installCopy.ts:40-88  copyInstalledFiles  (matches install)");
    expect(block).toContain("note: 2 of 3 files in the grep output are tests or docs");
    expect(formatPointerBlock([], ["src/x.ts"])).toBe("");
  });
});
