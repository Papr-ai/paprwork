import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  SEARCH_MAX_FILE_BYTES,
  SEARCH_STREAM_THRESHOLD_BYTES,
  searchWithWalk,
} from "../../src/core/tools/fileSearch.js";

let dir: string;
const run = (query: string, extra: Record<string, unknown> = {}) =>
  searchWithWalk(
    { searchPath: dir, query, filePattern: "", caseSensitive: false, maxResults: 50, ...extra },
    Date.now() + 20_000,
    { ok: true },
  );

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "walk-search-"));
  const filler = Array.from({ length: 140000 }, (_, i) => `row ${i} ${"x".repeat(60)}`);
  // ~11MB: above the streaming threshold, needle on the last line.
  fs.writeFileSync(path.join(dir, "big.txt"), [...filler, "the Harvard needle"].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "small.txt"), "alpha\nBeta needle\ngamma\n");
  // Sparse file just over the cap (instant, no real disk use).
  const huge = path.join(dir, "huge.log");
  fs.closeSync(fs.openSync(huge, "w"));
  fs.truncateSync(huge, SEARCH_MAX_FILE_BYTES + 1);
  fs.writeFileSync(path.join(dir, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("search_files walk engine", () => {
  it("finds a match deep in a file above the streaming threshold, with the right line", async () => {
    expect(fs.statSync(path.join(dir, "big.txt")).size).toBeGreaterThan(SEARCH_STREAM_THRESHOLD_BYTES);
    const r = await run("harvard");
    const hit = r.matches.find((m) => m.file.endsWith("big.txt"));
    expect(hit?.line).toBe(140001);
    expect(hit?.match.toLowerCase()).toBe("harvard");
  });

  it("small-file path is unchanged (case-insensitive, 1-indexed lines)", async () => {
    const r = await run("beta needle");
    expect(r.matches.map((m) => [path.basename(m.file), m.line])).toEqual([["small.txt", 2]]);
  });

  it("reports files over the cap instead of silently skipping them", async () => {
    const r = await run("needle");
    expect(r.skippedCount).toBe(1);
    expect(r.skipped?.[0]).toMatchObject({ reason: "too_large", sizeBytes: SEARCH_MAX_FILE_BYTES + 1 });
    expect(r.skipped?.[0].file.endsWith("huge.log")).toBe(true);
    expect(r.hint).toMatch(/NOT searched/);
  });

  it("does not count skipped or binary files as scanned", async () => {
    const r = await run("needle");
    expect(r.filesScanned).toBe(2); // big.txt + small.txt only
    expect(r.skipped?.some((s) => s.file.endsWith("image.bin"))).toBe(false);
  });

  it("omits skipped fields when nothing was skipped", async () => {
    const r = await run("needle", { filePattern: "small.txt" });
    expect(r.skipped).toBeUndefined();
    expect(r.skippedCount).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });

  it("stops streaming at maxResults", async () => {
    const r = await run("row", { maxResults: 3, filePattern: "big.txt" });
    expect(r.count).toBe(3);
    expect(r.truncatedReason).toBe("max_results");
  });
});
