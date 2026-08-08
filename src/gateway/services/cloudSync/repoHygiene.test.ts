import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_TRACKED_FILE_BYTES,
  REPO_SIZE_CRITICAL_BYTES,
  REPO_SIZE_WARN_BYTES,
  classifyRepoSize,
  matchesNeverTrack,
  partitionStagePaths,
  sweepStaleTmpPacks,
} from "./repoHygiene.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-hygiene-"));
  fs.mkdirSync(path.join(dir, ".git", "objects", "pack"), { recursive: true });
  return dir;
}

describe("matchesNeverTrack", () => {
  it("rejects SQLite databases and sidecars", () => {
    expect(matchesNeverTrack("apps/x/database.db")).toBe(true);
    expect(matchesNeverTrack("apps/x/database.db-wal")).toBe(true);
    expect(matchesNeverTrack("apps/x/database.db-shm")).toBe(true);
    expect(matchesNeverTrack("Jobs/y/data.sqlite3")).toBe(true);
  });

  it("rejects backup blobs, including suffixed ones", () => {
    expect(matchesNeverTrack("apps/x/database.db.bak.capital-one-ventures")).toBe(true);
    expect(matchesNeverTrack("apps/x/notes.bak")).toBe(true);
  });

  it("rejects anything under a backups/ directory at any depth", () => {
    expect(matchesNeverTrack("backups/migration-1/jobs-src.tgz")).toBe(true);
    expect(matchesNeverTrack("orgs/a/namespaces/b/backups/x.db")).toBe(true);
  });

  it("allows normal source files", () => {
    expect(matchesNeverTrack("apps/x/index.html")).toBe(false);
    expect(matchesNeverTrack("workspace/notes.md")).toBe(false);
    expect(matchesNeverTrack("apps/x/dist/app.js")).toBe(false);
  });
});

describe("partitionStagePaths", () => {
  it("drops oversized files and keeps small ones", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "small.ts"), "export const a = 1;");
    fs.writeFileSync(
      path.join(dir, "huge.bin"),
      Buffer.alloc(MAX_TRACKED_FILE_BYTES + 1024),
    );

    const { allowed, rejected } = partitionStagePaths(dir, [
      "small.ts",
      "huge.bin",
    ]);
    expect(allowed).toEqual(["small.ts"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].path).toBe("huge.bin");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps missing paths so deletions still commit", () => {
    const dir = tmpRepo();
    const { allowed } = partitionStagePaths(dir, ["deleted-file.ts"]);
    expect(allowed).toEqual(["deleted-file.ts"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("sweepStaleTmpPacks", () => {
  it("removes old temp packs but spares fresh ones", () => {
    const dir = tmpRepo();
    const packDir = path.join(dir, ".git", "objects", "pack");
    const stale = path.join(packDir, "tmp_pack_STALE");
    const fresh = path.join(packDir, "tmp_pack_FRESH");
    const real = path.join(packDir, "pack-abc.pack");
    fs.writeFileSync(stale, "x".repeat(1000));
    fs.writeFileSync(fresh, "x".repeat(1000));
    fs.writeFileSync(real, "x".repeat(1000));

    const old = Date.now() - 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);

    const result = sweepStaleTmpPacks(dir);
    expect(result.removedFiles).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(real)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when there is no pack directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-nogit-"));
    expect(sweepStaleTmpPacks(dir).removedFiles).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("classifyRepoSize", () => {
  it("classifies ok / warn / critical", () => {
    expect(classifyRepoSize(1024).level).toBe("ok");
    expect(classifyRepoSize(REPO_SIZE_WARN_BYTES).level).toBe("warn");
    expect(classifyRepoSize(REPO_SIZE_CRITICAL_BYTES).level).toBe("critical");
    // The 253 GB repo that motivated this fix.
    expect(classifyRepoSize(253 * 1024 ** 3).level).toBe("critical");
  });
});
