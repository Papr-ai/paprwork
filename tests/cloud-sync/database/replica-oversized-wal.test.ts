/**
 * Regression: a replica whose WAL grew to 19 GB in front of a 3.6 MB database (a job
 * rewrote ~700 rows every 15 minutes; Plan A never checkpoints) took 6-10 s to open. Every
 * open outlasted the request timeout, each timeout SIGKILLed the shared sync worker, and
 * every other database's requests failed with it in a 20 s restart loop.
 *
 * Two guards: an oversized WAL is re-seeded from cloud once on open, and a path whose
 * requests keep timing out is parked so it stops restarting the worker for everyone.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WAL_RESEED_BYTES,
  inspectOversizedReplicaWal,
  resetOversizedWalAttemptsForTests,
  resolveWalReseedBytes,
  scheduleOversizedWalReseed,
  type OversizedWalHealDeps,
} from "../../../src/gateway/services/tursoReplica/replicaOversizedWal.js";
import {
  MAX_CONSECUTIVE_PATH_TIMEOUTS,
  TursoReplicaSyncWorkerClient,
} from "../../../src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.js";
import { isParkedReplicaError } from "../../../src/gateway/services/tursoReplica/tursoReplicaErrors.js";
import type { DatabaseRecord } from "../../../src/gateway/services/DatabaseRegistryService.js";

let dir: string;
let dbPath: string;

function writeSized(file: string, bytes: number): void {
  const fd = fs.openSync(file, "w");
  try {
    if (bytes > 0) fs.ftruncateSync(fd, bytes); // sparse: no real disk use
  } finally {
    fs.closeSync(fd);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oversized-wal-"));
  dbPath = path.join(dir, "data.db");
  resetOversizedWalAttemptsForTests();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("inspectOversizedReplicaWal", () => {
  it("flags a WAL far larger than its database", () => {
    writeSized(dbPath, 4 * 1024 * 1024);
    writeSized(`${dbPath}-wal`, 600 * 1024 * 1024);
    const report = inspectOversizedReplicaWal(dbPath);
    expect(report.oversized).toBe(true);
    expect(report.walBytes).toBe(600 * 1024 * 1024);
  });

  it("leaves a small WAL alone", () => {
    writeSized(dbPath, 4 * 1024 * 1024);
    writeSized(`${dbPath}-wal`, 50 * 1024 * 1024);
    expect(inspectOversizedReplicaWal(dbPath).oversized).toBe(false);
  });

  it("leaves a big WAL that is proportionate to a big database alone", () => {
    writeSized(dbPath, 2 * 1024 * 1024 * 1024);
    writeSized(`${dbPath}-wal`, 700 * 1024 * 1024);
    expect(inspectOversizedReplicaWal(dbPath).oversized).toBe(false);
  });

  it("is off when the limit is 0, and tolerates missing files", () => {
    writeSized(dbPath, 1024);
    writeSized(`${dbPath}-wal`, 900 * 1024 * 1024);
    expect(inspectOversizedReplicaWal(dbPath, 0).oversized).toBe(false);
    expect(inspectOversizedReplicaWal(path.join(dir, "missing.db")).oversized).toBe(false);
  });

  it("reads the limit from the environment", () => {
    expect(resolveWalReseedBytes(undefined)).toBe(DEFAULT_WAL_RESEED_BYTES);
    expect(resolveWalReseedBytes("1048576")).toBe(1048576);
    expect(resolveWalReseedBytes("0")).toBe(0);
    expect(resolveWalReseedBytes("nope")).toBe(DEFAULT_WAL_RESEED_BYTES);
  });
});

describe("scheduleOversizedWalReseed", () => {
  const report = { oversized: true, walBytes: 19e9, dbBytes: 3.6e6 };
  const record = { dbId: "db-x", syncMode: "replica", localPath: "" } as unknown as DatabaseRecord;

  function deps(over: Partial<OversizedWalHealDeps> = {}): OversizedWalHealDeps & { reseed: ReturnType<typeof vi.fn> } {
    return {
      isOnline: () => true,
      getRecord: () => record,
      reseed: vi.fn(async () => undefined),
      ...over,
    } as OversizedWalHealDeps & { reseed: ReturnType<typeof vi.fn> };
  }

  it("re-seeds once per path per session", async () => {
    const d = deps();
    expect(await scheduleOversizedWalReseed(dbPath, report, d)).toBe(true);
    expect(await scheduleOversizedWalReseed(dbPath, report, d)).toBe(false);
    expect(d.reseed).toHaveBeenCalledTimes(1);
  });

  it("waits for a connection without using up its attempt", async () => {
    let online = false;
    const d = deps({ isOnline: () => online });
    expect(await scheduleOversizedWalReseed(dbPath, report, d)).toBe(false);
    online = true;
    expect(await scheduleOversizedWalReseed(dbPath, report, d)).toBe(true);
  });

  it("skips databases that are not replicas, and never throws", async () => {
    const legacy = deps({ getRecord: () => ({ ...record, syncMode: "legacy" }) as DatabaseRecord });
    expect(await scheduleOversizedWalReseed(dbPath, report, legacy)).toBe(false);
    expect(legacy.reseed).not.toHaveBeenCalled();
    const failing = deps({ reseed: vi.fn(async () => { throw new Error("offline"); }) });
    expect(await scheduleOversizedWalReseed(path.join(dir, "b.db"), report, failing)).toBe(false);
  });
});

/** A worker that boots and then never answers: every request times out. */
const SILENT_WORKER = `
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", () => {});
setInterval(() => {}, 1 << 30);
`;

describe("TursoReplicaSyncWorkerClient timeout park", () => {
  it(`parks a path after ${MAX_CONSECUTIVE_PATH_TIMEOUTS} consecutive timeouts`, async () => {
    const client = new TursoReplicaSyncWorkerClient(() => ({
      command: process.execPath,
      args: ["-e", SILENT_WORKER],
    }));
    const spec = {
      localPath: path.join(dir, "slow.db"),
      tursoUrl: "",
      authToken: "",
      bootstrapIfEmpty: false,
      timeoutMs: 150,
      retryOnCrash: "never" as const,
    };
    try {
      // Each request times out and SIGKILLs the worker. Under a loaded test runner the next
      // request can also fail as collateral of the previous kill (worker not writable yet),
      // which does not count, so keep asking until the park answers, with a bound.
      let parked: unknown = null;
      let timeouts = 0;
      for (let i = 0; i < 12 && !parked; i += 1) {
        const error = await client.query({ ...spec, sql: "SELECT 1" }).catch((e: unknown) => e);
        if (isParkedReplicaError(error)) parked = error;
        else if (/timed out after 150ms/.test(String(error))) timeouts += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(parked).not.toBeNull();
      expect(timeouts).toBe(MAX_CONSECUTIVE_PATH_TIMEOUTS);
      // Other databases are unaffected by the park.
      await expect(
        client.query({ ...spec, localPath: path.join(dir, "other.db"), sql: "SELECT 1" }),
      ).rejects.toThrow(/timed out/);
    } finally {
      await client.shutdown();
    }
  }, 20_000);
});
