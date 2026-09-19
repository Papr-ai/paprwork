/**
 * The bootstrap replay must never write beneath a live sync worker.
 *
 * `replayBootstrapSnapshot` copies preserved rows back with better-sqlite3. If the
 * @tursodatabase/sync worker still holds the same file, that bulk write reallocates pages
 * under root pointers the engine has cached, and the engine aborts the *process* from
 * `btree.rs` — `Invalid page type: 0`, or `unreachable!()` on a rowid index. The abort resets
 * the sidecars, the reset re-bootstraps, and the bootstrap replays again, so the corruption
 * renews itself on every launch.
 *
 * A native abort cannot be caught, so the only defence is a precondition. Two things have to
 * hold and each is pinned separately: the caller closes the worker before replaying, and the
 * replay refuses if it is called anyway.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The module under test imports better-sqlite3, which is built for Electron's ABI and throws
// ERR_DLOPEN_FAILED under plain node. The guard runs before any database is opened, so a stub
// is enough to reach it — and a constructor that throws doubles as proof the guard ran first.
vi.mock("better-sqlite3", () => ({
  default: class {
    constructor() {
      throw new Error("better-sqlite3 opened — the ownership guard did not run first");
    }
  },
}));

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO, relativePath), "utf-8");
}

/**
 * Strip comments before searching source.
 *
 * Line comments first: this file's own rationale names `close(` and `replayBootstrapSnapshot`,
 * and a block-comment opener inside a line comment would otherwise swallow everything to the
 * next closer — Issue 98 lost ~340 lines of anchors that way.
 */
function stripComments(source: string): string {
  return source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Index of `needle`, asserting it exists so ordering checks cannot read -1. */
function requireIndex(haystack: string, file: string, needle: string): number {
  const idx = haystack.indexOf(needle);
  if (idx === -1) {
    throw new Error(`[${file}] expected to find ${JSON.stringify(needle)}`);
  }
  return idx;
}

describe("replayBootstrapSnapshot — worker ownership precondition", () => {
  it("throws when the worker still owns the path", async () => {
    const { replayBootstrapSnapshot, ReplicaWorkerOwnsPathError } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaBootstrapReplay.js"
    );

    expect(() =>
      replayBootstrapSnapshot("/tmp/data.db", "/tmp/data.db-papr-presnapshot", () => true),
    ).toThrow(ReplicaWorkerOwnsPathError);
  });

  it("names the file and the remedy, because the caller logs this at the user", async () => {
    const { replayBootstrapSnapshot } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaBootstrapReplay.js"
    );

    expect(() =>
      replayBootstrapSnapshot("/tmp/jobs/data.db", "/tmp/jobs/snap.db", () => true),
    ).toThrow(/\/tmp\/jobs\/data\.db/);
    expect(() =>
      replayBootstrapSnapshot("/tmp/jobs/data.db", "/tmp/jobs/snap.db", () => true),
    ).toThrow(/close/i);
  });

  it("checks ownership before the file-existence tests", async () => {
    // Both paths are absent, so an existence-first ordering would return an empty result
    // instead of throwing — and the fatal condition would be skipped for any replay whose
    // snapshot had already been cleaned up.
    const { replayBootstrapSnapshot, ReplicaWorkerOwnsPathError } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaBootstrapReplay.js"
    );

    expect(() =>
      replayBootstrapSnapshot("/nonexistent/data.db", "/nonexistent/snap.db", () => true),
    ).toThrow(ReplicaWorkerOwnsPathError);
  });

  it("proceeds when the worker does not own the path", async () => {
    // Missing files short-circuit before better-sqlite3 is touched, so this reaches the
    // normal return rather than the stub constructor: the guard is not a blanket refusal.
    const { replayBootstrapSnapshot } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaBootstrapReplay.js"
    );

    const absent = path.join(os.tmpdir(), "papr-replay-absent", "data.db");
    expect(replayBootstrapSnapshot(absent, `${absent}-snap`, () => false)).toEqual({
      tablesReplayed: 0,
      rowsReplayed: 0,
      skipped: [],
    });
  });

  it("consults the live worker client by default", async () => {
    // The injectable parameter exists for these tests. A default that answered "false" would
    // make the guard inert in production while every test above still passed.
    const source = stripComments(
      read("src/gateway/services/tursoReplica/tursoReplicaBootstrapReplay.ts"),
    );
    expect(source).toContain("getTursoReplicaSyncWorkerClient().ownsPath");
  });
});

describe("settleBootstrapMarker — closes before replaying", () => {
  const FILE = "src/gateway/services/tursoReplica/TursoReplicaService.ts";

  it("releases the worker handle before the replay call", () => {
    const source = stripComments(read(FILE));
    const closeIdx = requireIndex(source, FILE, "await this.close(localPath)");
    const replayIdx = requireIndex(source, FILE, "replayBootstrapSnapshot(localPath");

    expect(closeIdx).toBeLessThan(replayIdx);
  });

  it("awaits settleBootstrapMarker, so the close cannot be skipped by a floating promise", () => {
    const source = stripComments(read(FILE));
    expect(source).toContain("await this.settleBootstrapMarker(localPath, marker)");
  });

  it("leaves the marker in place when a bootstrap attempt throws", () => {
    // The guard throws rather than returning empty. That is only safe because the caller
    // treats a throw as a failed attempt and keeps the marker and snapshot for the next try;
    // clearing on throw would strand local-only rows the replay exists to preserve.
    const source = stripComments(read(FILE));
    expect(source).toContain("noteBootstrapAttemptFailed(localPath");
  });
});
