import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TursoReplicaSyncWorkerClient } from "../src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.js";
import {
  DURABLE_PARK_TTL_MS,
  durableParkPath,
  readDurablePark,
  writeDurablePark,
} from "../src/gateway/services/tursoReplica/replicaDurablePark.js";
import { isParkedReplicaError } from "../src/gateway/services/cloudSync/flushAppNow.js";

/** A worker that reports the btree panic from the real crash report, then aborts. */
function btreePanicWorker(): { command: string; args: string[] } {
  const script = `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: req.id, started: true }) + "\\n");
      process.stderr.write("thread '<unnamed>' panicked at core/storage/btree.rs:951:18:\\n" +
        "internal error: entered unreachable code: index where has_rowid() is true\\n");
      setTimeout(() => process.abort(), 20);
    });
    process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
  `;
  return { command: process.execPath, args: ["-e", script] };
}

let tmpDir: string;
let localPath: string;

const spec = () => ({
  localPath,
  tursoUrl: "libsql://example.turso.io",
  authToken: "token",
  bootstrapIfEmpty: false,
  timeoutMs: 10_000,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-durable-park-"));
  localPath = path.join(tmpDir, "data.db");
  fs.writeFileSync(localPath, "not a database");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("durable park record", () => {
  it("applies to the file it was written for", () => {
    writeDurablePark(localPath, "corrupt btree");
    expect(readDurablePark(localPath)).toBe("corrupt btree");
  });

  it("stops applying once data.db changes, and removes itself", () => {
    // A re-seed or restore replaces the bytes the evidence was about.
    writeDurablePark(localPath, "corrupt btree");
    fs.writeFileSync(localPath, "a re-seeded database, longer than before");
    expect(readDurablePark(localPath)).toBeNull();
    expect(fs.existsSync(durableParkPath(localPath))).toBe(false);
  });

  it("stops applying once the WAL changes", () => {
    writeDurablePark(localPath, "corrupt btree");
    fs.writeFileSync(`${localPath}-wal`, "new frames");
    expect(readDurablePark(localPath)).toBeNull();
  });

  it("expires, so a remote that was since fixed is retried", () => {
    const parkedAt = 1_000_000;
    writeDurablePark(localPath, "corrupt btree", parkedAt);
    expect(readDurablePark(localPath, parkedAt + DURABLE_PARK_TTL_MS - 1)).toBe(
      "corrupt btree",
    );
    expect(readDurablePark(localPath, parkedAt + DURABLE_PARK_TTL_MS)).toBeNull();
  });

  it("treats an unparseable record as absent rather than as a park", () => {
    fs.writeFileSync(durableParkPath(localPath), "{not json");
    expect(readDurablePark(localPath)).toBeNull();
    expect(fs.existsSync(durableParkPath(localPath))).toBe(false);
  });

  it("writes nothing when data.db is missing", () => {
    fs.rmSync(localPath);
    writeDurablePark(localPath, "corrupt btree");
    expect(fs.existsSync(durableParkPath(localPath))).toBe(false);
  });
});

describe("TursoReplicaSyncWorkerClient across a relaunch", () => {
  it("does not hand a file that aborted the engine to a new session's engine", async () => {
    let firstSpawns = 0;
    const first = new TursoReplicaSyncWorkerClient(() => {
      firstSpawns += 1;
      return btreePanicWorker();
    });
    await expect(first.sync(spec(), "pull")).rejects.toThrow();
    await first.shutdown();
    expect(firstSpawns).toBeGreaterThan(0);
    expect(fs.existsSync(durableParkPath(localPath))).toBe(true);

    // The relaunch: fresh client, no in-memory state. It must refuse before spawning.
    let secondSpawns = 0;
    const second = new TursoReplicaSyncWorkerClient(() => {
      secondSpawns += 1;
      return btreePanicWorker();
    });
    const error = await second.sync(spec(), "pull").catch((e: unknown) => e);
    await second.shutdown();

    expect(secondSpawns).toBe(0);
    expect((error as Error).message).toMatch(/stays parked across restarts/);
    // Publish must still treat it as parked rather than as a push failure.
    expect(isParkedReplicaError((error as Error).message)).toBe(true);
  });

  it("opens the file again once it has changed", async () => {
    writeDurablePark(localPath, "corrupt btree");
    fs.writeFileSync(localPath, "re-seeded from cloud, different size");
    let spawns = 0;
    const client = new TursoReplicaSyncWorkerClient(() => {
      spawns += 1;
      return btreePanicWorker();
    });
    await client.sync(spec(), "pull").catch(() => undefined);
    await client.shutdown();
    expect(spawns).toBeGreaterThan(0);
  });
});

describe("isParkedReplicaError", () => {
  it("matches both wordings the client produces", () => {
    expect(
      isParkedReplicaError(
        "Turso replica /x/data.db is parked for this session: aborted 3 times.",
      ),
    ).toBe(true);
    expect(
      isParkedReplicaError("Turso replica /x/data.db is parked: corrupt btree."),
    ).toBe(true);
    expect(isParkedReplicaError("Turso push failed: migration conflict")).toBe(false);
  });
});
