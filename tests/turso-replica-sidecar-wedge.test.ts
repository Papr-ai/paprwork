import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectReplicaSidecarWedge,
  inspectReplicaSidecarWedge,
  repairReplicaSidecarWedge,
} from "../src/gateway/services/tursoReplica/tursoReplicaSidecarWedge.js";

const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const WAL_MAGIC_BE = 0x377f0682;
const PAGE_SIZE = 4096;

const tempDirs: string[] = [];

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wedge-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "data.db");
  fs.writeFileSync(dbPath, "sqlite-data");
  return dbPath;
}

function writeSidecarInfo(
  dbPath: string,
  options: { watermark?: number; walFragmentNo?: number },
): void {
  fs.writeFileSync(
    `${dbPath}-info`,
    JSON.stringify({
      version: "v1",
      revert_since_wal_salt: null,
      revert_since_wal_watermark: options.watermark ?? 0,
      synced_revision: {
        type: "v1",
        revision: JSON.stringify({
          generation: 999999999999999998,
          wal_fragment_no: options.walFragmentNo ?? 0,
        }),
      },
    }),
  );
}

function writeWal(dbPath: string, frameCount: number): void {
  const header = Buffer.alloc(WAL_HEADER_BYTES);
  header.writeUInt32BE(WAL_MAGIC_BE, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(PAGE_SIZE, 8);
  const frames = Buffer.alloc(
    (WAL_FRAME_HEADER_BYTES + PAGE_SIZE) * frameCount,
  );
  fs.writeFileSync(`${dbPath}-wal`, Buffer.concat([header, frames]));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("detectReplicaSidecarWedge", () => {
  it("flags a watermark that names a frame an empty WAL cannot hold", () => {
    const dbPath = makeTempDb();
    fs.writeFileSync(`${dbPath}-wal`, "");
    writeSidecarInfo(dbPath, { watermark: 8, walFragmentNo: 20 });

    const report = inspectReplicaSidecarWedge(dbPath);

    expect(report.wedged).toBe(true);
    expect(report.reason).toBe("watermark_past_wal_end");
    expect(report.watermark).toBe(8);
    expect(report.walFrameCount).toBe(0);
  });

  it("flags a watermark past the end of a WAL that still has frames", () => {
    // The crash case: the old empty-WAL-only check returned false here, so pull()
    // reached find_frame with an unsatisfiable watermark and aborted the process.
    const dbPath = makeTempDb();
    writeWal(dbPath, 12);
    writeSidecarInfo(dbPath, { watermark: 4849, walFragmentNo: 2 });

    const report = inspectReplicaSidecarWedge(dbPath);

    expect(report.wedged).toBe(true);
    expect(report.reason).toBe("watermark_past_wal_end");
    expect(report.walFrameCount).toBe(12);
  });

  it("flags a watermark recorded against a missing WAL", () => {
    const dbPath = makeTempDb();
    writeSidecarInfo(dbPath, { watermark: 8 });

    expect(detectReplicaSidecarWedge(dbPath)).toBe(true);
  });

  it("does not flag a checkpointed replica whose remote fragment is non-zero", () => {
    // Healthy resting state: the WAL was checkpointed into data.db and
    // wal_fragment_no tracks the *remote* revision, not local frames.
    const dbPath = makeTempDb();
    fs.writeFileSync(`${dbPath}-wal`, "");
    writeSidecarInfo(dbPath, { watermark: 0, walFragmentNo: 85 });

    const report = inspectReplicaSidecarWedge(dbPath);

    expect(report.wedged).toBe(false);
    expect(report.reason).toBe("ok");
  });

  it("does not flag a watermark the WAL can satisfy", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, 40);
    writeSidecarInfo(dbPath, { watermark: 12, walFragmentNo: 3 });

    expect(detectReplicaSidecarWedge(dbPath)).toBe(false);
  });

  it("does not flag a watermark exactly at the last frame", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, 5);
    writeSidecarInfo(dbPath, { watermark: 5 });

    expect(detectReplicaSidecarWedge(dbPath)).toBe(false);
  });

  it("does not flag when the WAL cannot be parsed", () => {
    // An unparseable WAL is not proof the watermark is unsatisfiable, and repair
    // is destructive — stay out of the way and let the checkpoint-error path handle it.
    const dbPath = makeTempDb();
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(9000, 0xab));
    writeSidecarInfo(dbPath, { watermark: 99 });

    const report = inspectReplicaSidecarWedge(dbPath);

    expect(report.wedged).toBe(false);
    expect(report.reason).toBe("wal_unreadable");
  });

  it("does not flag when there is no sidecar info", () => {
    const dbPath = makeTempDb();

    expect(inspectReplicaSidecarWedge(dbPath).reason).toBe("no_sidecar_info");
  });

  it("does not flag a path with no database file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wedge-"));
    tempDirs.push(dir);

    expect(inspectReplicaSidecarWedge(path.join(dir, "data.db")).reason).toBe(
      "missing_db",
    );
  });

  it("tolerates malformed sidecar info", () => {
    const dbPath = makeTempDb();
    fs.writeFileSync(`${dbPath}-info`, "{not json");

    expect(detectReplicaSidecarWedge(dbPath)).toBe(false);
  });
});

describe("repairReplicaSidecarWedge", () => {
  it("removes wedged sidecars and keeps data.db", () => {
    const dbPath = makeTempDb();
    fs.writeFileSync(`${dbPath}-wal`, "");
    fs.writeFileSync(`${dbPath}-changes`, "{}");
    writeSidecarInfo(dbPath, { watermark: 12, walFragmentNo: 3 });

    expect(repairReplicaSidecarWedge(dbPath)).toBe(true);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("sqlite-data");
    expect(fs.existsSync(`${dbPath}-info`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-changes`)).toBe(false);
    expect(detectReplicaSidecarWedge(dbPath)).toBe(false);
  });

  it("leaves a healthy replica untouched", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, 40);
    writeSidecarInfo(dbPath, { watermark: 12, walFragmentNo: 3 });

    expect(repairReplicaSidecarWedge(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-info`)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
  });
});
