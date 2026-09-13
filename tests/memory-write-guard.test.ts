import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Journal lives under the Papr data dir; point it at a temp dir per test so
// these never touch the real workspace.
let tmpDir: string;
vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprDataDir: () => tmpDir,
}));

const {
  reserveMemoryWrite,
  hashMemoryContent,
  resetMemoryWriteGuard,
} = await import("../src/gateway/services/memoryWriteGuard.js");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-guard-"));
  resetMemoryWriteGuard();
});

afterEach(() => {
  resetMemoryWriteGuard();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("reserveMemoryWrite", () => {
  it("allows the first write and blocks an identical second one", () => {
    const body = "Database snapshot: Reddit Research\n## Table: posts\n42 rows";

    const first = reserveMemoryWrite(body, "database_snapshot");
    expect(first.proceed).toBe(true);
    first.commit();

    const second = reserveMemoryWrite(body, "database_snapshot");
    expect(second.proceed).toBe(false);
  });

  it("blocks a concurrent writer while the first is still IN FLIGHT", () => {
    // The measured failure: memoryId 7ba04fb2 has two rows at the identical
    // second (2026-09-04T10:52:26). A journal-only check cannot catch that,
    // because nothing is journalled until the first add returns. The
    // reservation must block from the moment it is taken.
    const body = "identical body from two concurrent syncs";

    const a = reserveMemoryWrite(body, "database_snapshot");
    const b = reserveMemoryWrite(body, "database_snapshot");

    expect(a.proceed).toBe(true);
    expect(b.proceed).toBe(false); // blocked BEFORE a.commit()

    a.commit();
  });

  it("blocks identical content from a DIFFERENT source", () => {
    // Measured: memoryId 05a6d704 covers render.ts and drawer.ts with
    // byte-identical content, and 6660c916 mixes database_snapshot with
    // database_summary. Identity is the body, not the file or the writer.
    const body = "import type { State } from './data';\nconst COLOR = {};";

    const fromRender = reserveMemoryWrite(body, "code_indexer");
    expect(fromRender.proceed).toBe(true);
    fromRender.commit();

    const fromDrawer = reserveMemoryWrite(body, "code_indexer");
    expect(fromDrawer.proceed).toBe(false);
  });

  it("allows a retry after release() — a failed write must not self-block", () => {
    const body = "content whose add() threw";

    const failed = reserveMemoryWrite(body, "code_indexer");
    expect(failed.proceed).toBe(true);
    failed.release(); // simulate add() rejecting

    const retry = reserveMemoryWrite(body, "code_indexer");
    expect(retry.proceed).toBe(true); // not blocked by our own reservation
  });

  it("allows different content through", () => {
    const a = reserveMemoryWrite("first body", "code_indexer");
    a.commit();
    const b = reserveMemoryWrite("second body", "code_indexer");
    expect(b.proceed).toBe(true);
  });

  it("survives a restart — journal is read from disk", async () => {
    const body = "persisted across processes";
    reserveMemoryWrite(body, "code_indexer").commit();

    // Fresh module instance = empty in-process Set, journal only.
    vi.resetModules();
    const reloaded = await import(
      "../src/gateway/services/memoryWriteGuard.js"
    );
    expect(reloaded.reserveMemoryWrite(body, "code_indexer").proceed).toBe(false);
  });

  it("treats empty content as always writable", () => {
    // No identity worth deduping; the caller decides.
    expect(reserveMemoryWrite("", "code_indexer").proceed).toBe(true);
    expect(reserveMemoryWrite("   ", "code_indexer").proceed).toBe(true);
  });

  it("FAILS OPEN when the journal is corrupt", () => {
    // Losing a memory is worse than storing a duplicate. A damaged journal
    // must never silently block writes.
    fs.writeFileSync(
      path.join(tmpDir, ".memory-write-hashes.json"),
      "{ not valid json",
      "utf8",
    );
    expect(reserveMemoryWrite("anything", "code_indexer").proceed).toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    expect(() =>
      reserveMemoryWrite(undefined as unknown as string, "x"),
    ).not.toThrow();
    expect(() => reserveMemoryWrite("a".repeat(200_000), "x")).not.toThrow();
  });

  it("hashes deterministically and distinctly", () => {
    expect(hashMemoryContent("abc")).toBe(hashMemoryContent("abc"));
    expect(hashMemoryContent("abc")).not.toBe(hashMemoryContent("abd"));
  });

  it("commit() is what persists — a reservation alone does not block forever", async () => {
    const body = "reserved but never committed";
    reserveMemoryWrite(body, "code_indexer"); // no commit, no release

    vi.resetModules();
    const reloaded = await import(
      "../src/gateway/services/memoryWriteGuard.js"
    );
    // Nothing was journalled, so a later process may legitimately write it.
    expect(reloaded.reserveMemoryWrite(body, "code_indexer").proceed).toBe(true);
  });
});
