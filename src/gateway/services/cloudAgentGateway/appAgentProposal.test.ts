import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAppProposalChanges, writeProposalBaseline } from "./appAgentProposal.js";

describe("app assistant proposal diff", () => {
  let home: string;
  const appId = "app-1";
  const app = (p: string) => path.join(home, "apps", appId, p);
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "proposal-"));
    await mkdir(app("src"), { recursive: true });
    await mkdir(app("dist"), { recursive: true });
    await writeFile(app("index.html"), "<p>a</p>");
    await writeFile(app("src/old.ts"), "x");
    await writeFile(app("dist/app.js"), "built");
    await writeProposalBaseline(home, appId, "a".repeat(40));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("returns null when nothing changed", async () => {
    expect(await collectAppProposalChanges(home, appId)).toBeNull();
  });

  it("captures edits, adds and deletes; ignores build output and scratch", async () => {
    await writeFile(app("index.html"), "<p>b</p>");
    await writeFile(app("src/new.ts"), "y");
    await rm(app("src/old.ts"));
    await writeFile(app("dist/app.js"), "rebuilt");
    await writeFile(app("notes.log"), "scratch");
    const out = await collectAppProposalChanges(home, appId);
    expect(out?.baseSha).toBe("a".repeat(40));
    expect(out?.files).toEqual([
      { path: "index.html", content: "<p>b</p>" },
      { path: "src/new.ts", content: "y" },
      { path: "src/old.ts", content: null },
    ]);
  });

  it("is cumulative across turns and skips binary files", async () => {
    await writeFile(app("index.html"), "<p>b</p>");
    await collectAppProposalChanges(home, appId);
    await writeFile(app("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0xff]));
    const out = await collectAppProposalChanges(home, appId);
    expect(out?.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(out?.skipped).toEqual(["logo.png"]);
  });
});
