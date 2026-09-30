import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_TRACKED_FILE_BYTES,
  REPO_SIZE_CRITICAL_BYTES,
  REPO_SIZE_WARN_BYTES,
  classifyRepoSize,
  sweepStaleTmpPacks,
} from "./repoHygiene.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-hygiene-"));
  fs.mkdirSync(path.join(dir, ".git", "objects", "pack"), { recursive: true });
  return dir;
}

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
    expect(classifyRepoSize(253 * 1024 ** 3).level).toBe("critical");
  });
});

describe("MAX_TRACKED_FILE_BYTES", () => {
  it("matches git sync size limit export", () => {
    expect(MAX_TRACKED_FILE_BYTES).toBeGreaterThan(0);
  });
});
