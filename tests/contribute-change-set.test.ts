import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildProposalChangeSet } from "../src/gateway/services/cloudSync/contributeChangeSet.js";
import {
  dataSourcesForProposal,
  dataSourcesForPull,
  isLocalScratchPath,
  isReadmeStub,
  jobJsonForProposal,
  linkedDatabasesForProposal,
} from "../src/gateway/services/cloudSync/proposalFileMerge.js";
import {
  inferBaseCommitFromLocal,
  mergeFileContents,
  previewMergeConflicts,
  readFilesAtCommit,
} from "../src/gateway/services/cloudSync/threeWayMerge.js";
import { hashBlobContent } from "../src/gateway/services/syncV3/computeParentHash.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).toString().trim();
}

function repoWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-repo-"));
  tmp.push(dir);
  git(dir, "init", "-q", "-b", "main");
  commit(dir, files, "c0");
  return dir;
}

function commit(dir: string, files: Record<string, string | null>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (content === null) fs.rmSync(p, { force: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

const STUB = "# app-932a41fe-0a94-4d8f-a3f7-f1852188f2d1\nPapr app repo: 932a41fe-0a94-4d8f-a3f7-f1852188f2d1\n";

describe("buildProposalChangeSet", () => {
  it("sends only real edits, never the publisher's newer files", () => {
    const base = new Map([
      ["app.ts", "a\n"],
      ["data.ts", "d\n"],
      ["README.md", "# Investor Review\n"],
    ]);
    const local = new Map([
      ["app.ts", "a\nmine\n"], // edited
      ["data.ts", "d\n"], // untouched (publisher may have changed it since)
      ["new.ts", "n\n"], // added
      ["README.md", STUB], // installer stub
      ["dist/app.js", "bundle"],
      ["metadata.json", "{}"],
      ["papr-cloud-dependencies.json", "{}"],
    ]);
    const cs = buildProposalChangeSet([{ repoDir: ".", local, base, kind: "app" }]);
    expect([...cs.writes.keys()].sort()).toEqual(["app.ts", "new.ts"]);
    expect(cs.deletes).toEqual([]);
    expect(cs.ignored).toContain("README.md");
  });

  it("proposes deletions but never deletes migrations or platform files", () => {
    const cs = buildProposalChangeSet([
      {
        repoDir: ".",
        local: new Map([["app.ts", "a"]]),
        base: new Map([
          ["app.ts", "a"],
          ["old.ts", "o"],
          ["data-sources.json", '{"sources":[]}'],
          ["databases/x/migrations/0007_a.sql", "--"],
        ]),
        kind: "app",
      },
    ]);
    expect(cs.deletes).toEqual(["old.ts"]);
  });

  it("job trees: skips run output and backups, field-merges job.json", () => {
    const baseJob = JSON.stringify({ id: "j", name: "W", command: "python3 a.py", requiredKeys: ["K"], schedule: { enabled: true, cron: "1 * * * *" } });
    const localJob = JSON.stringify({ id: "j", name: "W", command: "python3 a.py", schedule: { enabled: false, cron: "1 * * * *" }, status: "completed", executionCapability: "local-only" });
    const cs = buildProposalChangeSet([
      {
        repoDir: "jobs/j",
        kind: "job",
        base: new Map([["job.json", baseJob], ["code/w.py", "x\n"]]),
        local: new Map([
          ["job.json", localJob],
          ["code/w.py", "x\ny\n"],
          ["code/w.py.bak-20260926", "old"],
          ["code/__pycache__/w.cpython-314.pyc", "bin"],
          ["data/linkedin_views.json", "{}"],
          ["logs/run.log", "..."],
        ]),
      },
    ]);
    // Local schedule off + dropped requiredKeys are not proposals.
    expect([...cs.writes.keys()]).toEqual(["jobs/j/code/w.py"]);
  });

  it("app folder's bundled jobs/ copy is owned by the job trees", () => {
    const cs = buildProposalChangeSet([
      {
        repoDir: ".",
        kind: "app",
        skipPrefixes: ["jobs/"],
        base: new Map([["jobs/j/code/w.py", "new upstream"]]),
        local: new Map([["jobs/j/code/w.py", "stale"]]),
      },
    ]);
    expect(cs.writes.size).toBe(0);
    expect(cs.deletes).toEqual([]);
  });
});

describe("platform file rules", () => {
  const pub = JSON.stringify({ sources: [{ id: "db-1:a", dbId: "db-1", dbPath: "" }, { id: "j1", jobId: "j1", dbPath: "" }] });
  const mine = JSON.stringify({ sources: [{ id: "db-1:a", dbId: "db-1", dbPath: "/Users/me/x.db" }] });

  it("data-sources: dropped links are not removals; new links are added portable", () => {
    expect(dataSourcesForProposal(pub, mine)).toBeNull();
    const withNew = JSON.stringify({ sources: [{ id: "db-1:a", dbId: "db-1", dbPath: "/x" }, { id: "db-9:n", dbId: "db-9", dbPath: "/Users/me/n.db" }] });
    const out = JSON.parse(dataSourcesForProposal(pub, withNew)!);
    expect(out.sources.map((s: { id: string }) => s.id)).toEqual(["db-1:a", "j1", "db-9:n"]);
    expect(out.sources[2].dbPath).toBe("");
  });

  it("data-sources pull keeps local paths and adds publisher links", () => {
    const out = JSON.parse(dataSourcesForPull(mine, pub)!);
    expect(out.sources[0].dbPath).toBe("/Users/me/x.db");
    expect(out.sources.map((s: { id: string }) => s.id)).toEqual(["db-1:a", "j1"]);
    expect(dataSourcesForPull(pub, pub)).toBeNull();
  });

  it("linked-databases: only new databases, without machine state", () => {
    const base = JSON.stringify({ version: 1, databases: { "db-1": { dbId: "db-1" } } });
    const local = JSON.stringify({
      version: 1,
      databases: {
        "db-1": { dbId: "db-1", lastReplicaPushError: "boom" },
        "db-9": { dbId: "db-9", localPath: "/Users/me/n.db", lastReplicaPushAt: "t", label: "new" },
      },
    });
    const out = JSON.parse(linkedDatabasesForProposal(base, local)!);
    expect(out.databases["db-1"]).toEqual({ dbId: "db-1" });
    expect(out.databases["db-9"]).toEqual({ dbId: "db-9", localPath: "", label: "new" });
    expect(linkedDatabasesForProposal(base, base)).toBeNull();
  });

  it("job.json: real config edits and cron changes go through", () => {
    const base = JSON.stringify({ id: "j", command: "a", schedule: { enabled: true, cron: "1 * * * *" } });
    const local = JSON.stringify({ id: "j", command: "b", schedule: { enabled: false, cron: "5 * * * *" } });
    const out = JSON.parse(jobJsonForProposal(base, local)!);
    expect(out.command).toBe("b");
    expect(out.schedule).toEqual({ enabled: true, cron: "5 * * * *" });
  });

  it("recognises scratch files and the README stub", () => {
    expect(isLocalScratchPath("code/w.py.bak-20260926", { job: true })).toBe(true);
    expect(isLocalScratchPath("data/x.json", { job: true })).toBe(true);
    expect(isLocalScratchPath("data/share-people-allowlist.json")).toBe(false);
    expect(isLocalScratchPath("code/w.py", { job: true })).toBe(false);
    expect(isReadmeStub(STUB)).toBe(true);
    expect(isReadmeStub("# Investor Review\n")).toBe(false);
  });
});

describe("git helpers", () => {
  it("merges edits to different lines and flags overlapping ones", async () => {
    const base = "1\n2\n3\n4\n5\n";
    const clean = await mergeFileContents("1\nmine\n3\n4\n5\n", base, "1\n2\n3\n4\ntheirs\n");
    expect(clean).toEqual({ clean: true, content: "1\nmine\n3\n4\ntheirs\n" });
    const clash = await mergeFileContents("1\nmine\n3\n4\n5\n", base, "1\ntheirs\n3\n4\n5\n");
    expect(clash.clean).toBe(false);
  });

  it("infers the commit a stale copy started from", async () => {
    const repo = repoWith({ "app.ts": "v1\n", "data.ts": "d1\n" });
    const c0 = git(repo, "rev-parse", "HEAD");
    commit(repo, { "data.ts": "d2\n", "boot.ts": "b\n" }, "c1");
    // Collaborator: untouched data.ts from c0, edited app.ts.
    const local = new Map([
      ["app.ts", hashBlobContent("v1 edited\n")],
      ["data.ts", hashBlobContent("d1\n")],
    ]);
    expect(await inferBaseCommitFromLocal(repo, local)).toBe(c0);
  });

  it("branching from the base: stale files don't revert, overlaps are caught", async () => {
    const repo = repoWith({ "app.ts": "a\nb\nc\n", "data.ts": "d1\n" });
    const base = git(repo, "rev-parse", "HEAD");
    commit(repo, { "data.ts": "d2\n", "app.ts": "a\nb\nC-theirs\n" }, "publisher moves on");
    const main = git(repo, "rev-parse", "HEAD");

    const baseFiles = await readFilesAtCommit(repo, base, ".");
    expect(baseFiles.get("data.ts")).toBe("d1\n");
    const cs = buildProposalChangeSet([
      { repoDir: ".", kind: "app", base: baseFiles, local: new Map([["app.ts", "A-mine\nb\nc\n"], ["data.ts", "d1\n"]]) },
    ]);
    expect([...cs.writes.keys()]).toEqual(["app.ts"]); // stale data.ts not sent

    git(repo, "checkout", "-q", "-b", "contrib", base);
    commit(repo, Object.fromEntries(cs.writes), "contrib");
    expect(await previewMergeConflicts(repo, main, "HEAD")).toEqual([]);

    git(repo, "checkout", "-q", "-b", "contrib2", base);
    commit(repo, { "app.ts": "a\nb\nC-mine\n" }, "overlap");
    expect(await previewMergeConflicts(repo, main, "HEAD")).toEqual(["app.ts"]);
  });
});
