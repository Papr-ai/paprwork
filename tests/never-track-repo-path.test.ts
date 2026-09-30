/**
 * Path exclusions for the writer door.
 *
 * These specs decide what never enters app sync. They were matched as bare
 * substrings, which both worked (SQLite files were excluded) and quietly
 * misfired: `*.db` matched `sandbox.ts`, `*.mov` matched `remove.ts`. Ordinary
 * source files were dropped from sync with no error anywhere.
 */

import { describe, expect, it } from "vitest";

import {
  isNeverTrackRepoPath,
  validateOpFileForWriter,
} from "../src/gateway/services/appRepoWriter/abuseFilter.js";
import { MAX_TRACKED_FILE_BYTES } from "../src/gateway/services/cloudSync/repoHygiene.js";

describe("isNeverTrackRepoPath", () => {
  it("excludes SQLite databases and their sidecars", () => {
    for (const repoPath of [
      "database.db",
      "data/database.db",
      "data/app.sqlite",
      "data/app.sqlite3",
      "data/database.db-wal",
      "data/database.db-shm",
      "data/database.db-journal",
    ]) {
      expect(isNeverTrackRepoPath(repoPath), repoPath).toBe(true);
    }
  });

  it("excludes backup copies, including dated infixes", () => {
    for (const repoPath of [
      "database.db.bak",
      "database.db.bak.capital-one-ventures",
      "data/registry.json.bak.2026-08-21",
      "backups/database.db",
      "data/backups/old.json",
    ]) {
      expect(isNeverTrackRepoPath(repoPath), repoPath).toBe(true);
    }
  });

  it("excludes archives and media", () => {
    for (const repoPath of [
      "assets/bundle.zip",
      "assets/clip.mp4",
      "assets/take.mov",
      "assets/voice.wav",
      "release.tar.gz",
    ]) {
      expect(isNeverTrackRepoPath(repoPath), repoPath).toBe(true);
    }
  });

  it("keeps source files whose names merely contain a spec's letters", () => {
    // Each of these was excluded from sync by substring matching.
    for (const repoPath of [
      "src/remove.ts", // *.mov
      "src/sandbox.ts", // *.db
      "src/dbutils.ts", // *.db
      "components/movie.tsx", // *.mov
      "utils/zipcode.ts", // *.zip
      "audio/waveform.ts", // *.wav
      "lib/mp4parse.ts", // *.mp4
      "index.html",
      "metadata.json",
    ]) {
      expect(isNeverTrackRepoPath(repoPath), repoPath).toBe(false);
    }
  });

  it("excludes stranded git repack temp files", () => {
    expect(isNeverTrackRepoPath("tmp_pack_abc123")).toBe(true);
  });

  it("always tracks app backend scaffold helpers", () => {
    for (const repoPath of [
      "backend/papr_db.py",
      "backend/db_helper.py",
      "apps/demo/backend/papr_db.py",
    ]) {
      expect(isNeverTrackRepoPath(repoPath), repoPath).toBe(false);
    }
  });
});

describe("validateOpFileForWriter", () => {
  it("rejects excluded paths", () => {
    expect(
      validateOpFileForWriter({ path: "data/database.db", content: "x" }),
    ).toMatchObject({ reason: expect.stringContaining("hygiene") });
  });

  it("rejects path traversal", () => {
    expect(
      validateOpFileForWriter({ path: "../escape.ts", content: "x" }),
    ).toMatchObject({ reason: "invalid path" });
  });

  it("rejects content over the tracked file limit", () => {
    const rejection = validateOpFileForWriter({
      path: "big.txt",
      content: "a".repeat(MAX_TRACKED_FILE_BYTES + 1),
    });
    expect(rejection?.reason).toContain("byte limit");
  });

  it("accepts an ordinary source file", () => {
    expect(
      validateOpFileForWriter({ path: "src/remove.ts", content: "export {};" }),
    ).toBeNull();
  });
});
