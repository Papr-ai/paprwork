import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodeIndexTracker } from "../src/gateway/services/storage/CodeIndexTracker.js";

/**
 * End-to-end guard: ONE file on disk must have ONE identity in the tracker,
 * no matter which spelling of its path the caller supplies.
 *
 * Before path normalization the tracker keyed on the raw string, so indexing
 * the same file via two spellings produced two rows, two queue entries and two
 * separately-enriched memories.
 */
describe("CodeIndexTracker path identity", () => {
  let work: string;
  let dataDir: string;
  let file: string;
  let alias: string;
  let tracker: CodeIndexTracker;

  beforeAll(() => {
    work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "papr-track-")));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-track-db-"));

    const appDir = path.join(work, "apps", "app-1");
    fs.mkdirSync(appDir, { recursive: true });
    file = path.join(appDir, "app.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    // A second, equally valid spelling of the SAME file (symlinked root).
    const aliasRoot = path.join(work, "ALIAS_ROOT");
    fs.symlinkSync(work, aliasRoot);
    alias = path.join(aliasRoot, "apps", "app-1", "app.ts");

    tracker = new CodeIndexTracker(dataDir);
  });

  afterAll(() => {
    try {
      (tracker as unknown as { close?: () => void }).close?.();
    } catch {
      /* ignore */
    }
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("an alias spelling does NOT trigger a second index of the same file", () => {
    expect(tracker.needsIndexing(file)).toBe(true);

    tracker.recordIndexedFile({
      file_path: file,
      content_hash: tracker.calculateFileHash(file),
      last_indexed_at: new Date(),
      schema_version: "v1",
      memory_id: "mem-canonical",
      project_id: "app-1",
      lines_of_code: 1,
      language: "TypeScript",
    });

    // THE REGRESSION: this returned true before normalization.
    expect(tracker.needsIndexing(alias)).toBe(false);
    expect(tracker.getIndexedFilesCount()).toBe(1);
  });

  test("queueing both spellings yields a single queue entry", () => {
    tracker.queueFile(file);
    tracker.queueFile(alias);
    expect(tracker.getQueueSize()).toBe(1);
  });

  test("dequeue by either spelling clears the entry", () => {
    tracker.queueFile(file);
    tracker.dequeueFile(alias);
    expect(tracker.getQueueSize()).toBe(0);
  });

  test("a genuine content change still re-indexes", () => {
    fs.writeFileSync(file, "export const a = 2; // changed\n");
    expect(tracker.needsIndexing(file)).toBe(true);
  });

  /**
   * These three call sites were added upstream AFTER the original fix was
   * written, and were the reason it had to be rebased onto master rather than
   * replayed as-is. They are the memoryId resolution path — an alias miss here
   * means upsertSummary cannot find the previous memory, falls through to
   * add(), and creates a SECOND separately-enriched memory for one file. That
   * is precisely the code_indexer duplication being fixed.
   */
  describe("memoryId resolution is alias-safe", () => {
    test("needsIndexingWithHash resolves an alias to the same row", () => {
      const hash = tracker.calculateFileHash(file);
      tracker.recordIndexedFile({
        file_path: file,
        content_hash: hash,
        last_indexed_at: new Date(),
        schema_version: "v1",
        memory_id: "mem-1",
        project_id: "app-1",
        lines_of_code: 1,
        language: "TypeScript",
      });
      // Same content via the alias spelling must NOT look like a new file.
      expect(tracker.needsIndexingWithHash(alias, hash)).toBe(false);
    });

    test("getIndexedFileMemoryId finds the memory via an alias", () => {
      expect(tracker.getIndexedFileMemoryId(alias)).toBe("mem-1");
    });

    test("setIndexedFileMemoryId via alias updates the canonical row", () => {
      tracker.setIndexedFileMemoryId(alias, "mem-2");
      expect(tracker.getIndexedFileMemoryId(file)).toBe("mem-2");
      // Still ONE row — the alias must not have inserted a second.
      expect(tracker.getIndexedFilesCount()).toBe(1);
    });
  });
});
