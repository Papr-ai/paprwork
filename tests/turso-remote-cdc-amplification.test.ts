/**
 * Regression tests for remote CDC amplification during Turso sync.
 *
 * Paprwork's own reconciliation writes (bootstrap snapshot, schema migration,
 * delta upsert) were applied to Turso with remote CDC triggers ACTIVE. Turso
 * then recorded each of those rows in its `_papr_sync_log` as if a cloud user
 * had edited them, so the next sync saw thousands of "new remote changes",
 * pulled and reconciled them, and generated yet more entries — an unbounded
 * feedback loop.
 *
 * Observed in production: a 1,141-row investors table produced 28,336 remote
 * insert entries (~25 full replays) and a 54,505-row changelog. Individual
 * libSQL requests then failed with `fetch failed` / `SQLITE_INTERNAL`, and the
 * app reported "Database sync to Turso failed".
 *
 * Two guards are covered here:
 *   1. withRemoteSyncMuted — platform writes are muted; genuine local edits are
 *      still mirrored explicitly afterwards.
 *   2. compactRemoteSyncLog hard ceiling — a log that has already blown past
 *      REMOTE_LOG_HARD_CEILING is compacted even when every entry is newer than
 *      the 7-day retention floor.
 */
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import {
  compactRemoteSyncLog,
  REMOTE_LOG_HARD_CEILING,
  withRemoteSyncMuted,
} from "../src/gateway/services/tursoSyncLog.js";

interface FakeRemoteOptions {
  /** Rows in _papr_sync_log reported by COUNT(*). */
  logCount?: number;
  /** MAX(id) of entries older than the retention floor. */
  retentionBoundary?: number;
  /** Existing compacted_through_id. */
  compactedThrough?: number;
  /** Throw on every mute-release UPDATE (simulates a flaky release). */
  failMuteRelease?: boolean;
}

/**
 * Minimal libSQL stand-in. Tracks mute depth the way the real trigger guard
 * reads it, so tests can assert what the depth was *during* a write.
 */
function createFakeRemote(options: FakeRemoteOptions = {}) {
  const statements: string[] = [];
  let muteDepth = 0;
  let muteReleaseAttempts = 0;

  const run = (sql: string) => {
    statements.push(sql);

    if (/UPDATE .*_papr_sync_mute.* depth = depth \+ 1/s.test(sql)) {
      muteDepth += 1;
      return { rows: [] };
    }
    if (/UPDATE .*_papr_sync_mute.* MAX\(depth - 1, 0\)/s.test(sql)) {
      muteReleaseAttempts += 1;
      if (options.failMuteRelease) {
        throw new Error("network blip releasing mute");
      }
      muteDepth = Math.max(muteDepth - 1, 0);
      return { rows: [] };
    }
    if (/COUNT\(\*\) AS count FROM "_papr_sync_log"/s.test(sql)) {
      return { rows: [{ count: options.logCount ?? 0 }] };
    }
    if (/compacted_through_id FROM "_papr_sync_meta"/s.test(sql)) {
      return {
        rows: [{ compacted_through_id: options.compactedThrough ?? 0 }],
      };
    }
    if (/MAX\(id\), 0\) AS boundary/s.test(sql)) {
      return { rows: [{ boundary: options.retentionBoundary ?? 0 }] };
    }
    return { rows: [] };
  };

  const remote = {
    execute: vi.fn(async (input: string | { sql: string }) =>
      run(typeof input === "string" ? input : input.sql),
    ),
    batch: vi.fn(async (items: Array<{ sql: string }>) =>
      items.map((i) => run(i.sql)),
    ),
    close: vi.fn(),
  };

  return {
    remote: remote as unknown as Client,
    statements,
    muteReleaseAttempts: () => muteReleaseAttempts,
    muteDepth: () => muteDepth,
  };
}

describe("withRemoteSyncMuted", () => {
  it("holds the mute for the duration of the platform write", async () => {
    const fake = createFakeRemote();
    const depthDuringWrite: number[] = [];

    await withRemoteSyncMuted(fake.remote, async () => {
      depthDuringWrite.push(fake.muteDepth());
    });

    // Muted while our rows land, released immediately afterwards so genuine
    // cloud-side edits are still captured.
    expect(depthDuringWrite).toEqual([1]);
    expect(fake.muteDepth()).toBe(0);
  });

  it("creates the mute table before incrementing", async () => {
    const fake = createFakeRemote();
    await withRemoteSyncMuted(fake.remote, async () => undefined);

    const createIdx = fake.statements.findIndex((sql) =>
      /CREATE TABLE IF NOT EXISTS "_papr_sync_mute"/.test(sql),
    );
    const acquireIdx = fake.statements.findIndex((sql) =>
      /depth = depth \+ 1/.test(sql),
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeGreaterThan(createIdx);
  });

  it("releases the mute when the write throws", async () => {
    const fake = createFakeRemote();

    await expect(
      withRemoteSyncMuted(fake.remote, async () => {
        throw new Error("upsert failed");
      }),
    ).rejects.toThrow("upsert failed");

    // A leaked remote mute would silently disable cloud CDC forever — the
    // mirror image of the local leak fixed in #88.
    expect(fake.muteDepth()).toBe(0);
  });

  it("nests without releasing the mute early", async () => {
    const fake = createFakeRemote();
    const depths: number[] = [];

    await withRemoteSyncMuted(fake.remote, async () => {
      await withRemoteSyncMuted(fake.remote, async () => {
        depths.push(fake.muteDepth());
      });
      // Inner scope must not unmute the outer one.
      depths.push(fake.muteDepth());
    });

    expect(depths).toEqual([2, 1]);
    expect(fake.muteDepth()).toBe(0);
  });

  it("retries a failing release and never throws out of the finally block", async () => {
    const fake = createFakeRemote({ failMuteRelease: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The push itself succeeded; a release failure must not turn that into an error.
    await expect(
      withRemoteSyncMuted(fake.remote, async () => "ok"),
    ).resolves.toBe("ok");

    expect(fake.muteReleaseAttempts()).toBe(3);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns the inner value", async () => {
    const fake = createFakeRemote();
    await expect(
      withRemoteSyncMuted(fake.remote, async () => ["investors"]),
    ).resolves.toEqual(["investors"]);
  });
});

describe("compactRemoteSyncLog hard ceiling", () => {
  it("respects the retention floor for a normally sized log", async () => {
    const fake = createFakeRemote({
      logCount: 5_000, // well under the ceiling
      retentionBoundary: 0, // nothing older than 7 days
    });

    const result = await compactRemoteSyncLog(fake.remote, 5_000);

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("retention_floor");
  });

  it("waives the retention floor once the log exceeds the ceiling", async () => {
    const watermark = 214_159;
    const fake = createFakeRemote({
      logCount: REMOTE_LOG_HARD_CEILING + 1, // amplified churn, all same-day
      retentionBoundary: 0,
      compactedThrough: 159_654,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await compactRemoteSyncLog(fake.remote, watermark);

    expect(result.compacted).toBe(true);
    expect(result.ceilingOverride).toBe(true);
    expect(result.throughId).toBe(watermark);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("marks compacted_through_id before deleting entries", async () => {
    const fake = createFakeRemote({
      logCount: REMOTE_LOG_HARD_CEILING + 1,
      retentionBoundary: 0,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await compactRemoteSyncLog(fake.remote, 60_000);

    const markerIdx = fake.statements.findIndex((sql) =>
      /SET compacted_through_id/.test(sql),
    );
    const deleteIdx = fake.statements.findIndex((sql) =>
      /DELETE FROM "_papr_sync_log"/.test(sql),
    );
    // Order matters: a consumer must never see deleted entries without the
    // marker, otherwise it silently delta-pulls a log with holes.
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(markerIdx);
    warnSpy.mockRestore();
  });

  it("does not compact below an existing watermark even at the ceiling", async () => {
    const fake = createFakeRemote({
      logCount: REMOTE_LOG_HARD_CEILING + 1,
      retentionBoundary: 0,
      compactedThrough: 90_000,
    });

    // Watermark behind what is already compacted — nothing new to retire.
    const result = await compactRemoteSyncLog(fake.remote, 80_000);
    expect(result.compacted).toBe(false);
  });

  it("still honours the minimum-entries threshold", async () => {
    const fake = createFakeRemote({
      logCount: REMOTE_LOG_HARD_CEILING + 1,
      compactedThrough: 999,
    });

    const result = await compactRemoteSyncLog(fake.remote, 1_000);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below_threshold");
  });
});
