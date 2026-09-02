import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readReplicaWalShape } from "../src/gateway/services/tursoReplica/tursoReplicaWalFrames.js";

const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const WAL_MAGIC_BE = 0x377f0682;

const tempDirs: string[] = [];

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wal-frames-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "data.db");
  fs.writeFileSync(dbPath, "sqlite");
  return dbPath;
}

/** Build a structurally valid WAL carrying `frameCount` frames of `pageSize` bytes. */
function writeWal(
  dbPath: string,
  options: { pageSize: number; frameCount: number; magic?: number },
): void {
  const { pageSize, frameCount } = options;
  const header = Buffer.alloc(WAL_HEADER_BYTES);
  header.writeUInt32BE(options.magic ?? WAL_MAGIC_BE, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(pageSize, 8);
  header.writeUInt32BE(1, 12);

  const frames = Buffer.alloc((WAL_FRAME_HEADER_BYTES + pageSize) * frameCount);
  fs.writeFileSync(`${dbPath}-wal`, Buffer.concat([header, frames]));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("readReplicaWalShape", () => {
  it("reports zero known frames when the WAL file is absent", () => {
    const shape = readReplicaWalShape(makeTempDb());

    expect(shape.exists).toBe(false);
    expect(shape.frameCount).toBe(0);
    expect(shape.frameCountKnown).toBe(true);
  });

  it("reports zero known frames for a checkpointed (0-byte) WAL", () => {
    const dbPath = makeTempDb();
    fs.writeFileSync(`${dbPath}-wal`, "");

    const shape = readReplicaWalShape(dbPath);

    expect(shape.exists).toBe(true);
    expect(shape.sizeBytes).toBe(0);
    expect(shape.frameCount).toBe(0);
    expect(shape.frameCountKnown).toBe(true);
  });

  it("counts frames using the page size from the WAL header", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, { pageSize: 4096, frameCount: 7 });

    const shape = readReplicaWalShape(dbPath);

    expect(shape.pageSizeBytes).toBe(4096);
    expect(shape.frameCount).toBe(7);
    expect(shape.frameCountKnown).toBe(true);
  });

  it("counts frames for a non-default page size", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, { pageSize: 512, frameCount: 3 });

    const shape = readReplicaWalShape(dbPath);

    expect(shape.pageSizeBytes).toBe(512);
    expect(shape.frameCount).toBe(3);
  });

  it("accepts the alternate checksum-endianness magic", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, { pageSize: 4096, frameCount: 2, magic: 0x377f0683 });

    const shape = readReplicaWalShape(dbPath);

    expect(shape.frameCountKnown).toBe(true);
    expect(shape.frameCount).toBe(2);
  });

  it("ignores a trailing partial frame", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, { pageSize: 4096, frameCount: 2 });
    fs.appendFileSync(`${dbPath}-wal`, Buffer.alloc(100));

    expect(readReplicaWalShape(dbPath).frameCount).toBe(2);
  });

  it("does not claim a frame count for a WAL with a bad magic", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, { pageSize: 4096, frameCount: 4, magic: 0xdeadbeef });

    const shape = readReplicaWalShape(dbPath);

    expect(shape.frameCountKnown).toBe(false);
    expect(shape.frameCount).toBe(0);
  });

  it("does not claim a frame count for an implausible page size", () => {
    const dbPath = makeTempDb();
    writeWal(dbPath, { pageSize: 5000, frameCount: 1 });

    expect(readReplicaWalShape(dbPath).frameCountKnown).toBe(false);
  });

  it("treats a sub-header-sized WAL as definitively empty", () => {
    const dbPath = makeTempDb();
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(20, 1));

    const shape = readReplicaWalShape(dbPath);

    // Below one header: zero frames is still a fact, not a parse failure.
    expect(shape.frameCount).toBe(0);
    expect(shape.frameCountKnown).toBe(true);
  });
});
