/**
 * Frame accounting for a @tursodatabase/sync replica WAL (`data.db-wal`).
 *
 * `data.db-info` stores `revert_since_wal_watermark`, a frame index into that WAL.
 * The sync engine resolves it with `WalFile::find_frame`, which asserts the frame
 * exists — if the watermark points past the last frame the assert fires as a Rust
 * `panic!`, and a panic in a napi worker aborts the whole process. There is no
 * JS-catchable error, so the only defence is to read the WAL ourselves and refuse
 * to hand the engine a watermark it cannot satisfy.
 *
 * WAL layout (SQLite file format, unchanged by Turso):
 *   32-byte header — magic u32be, format u32be, page size u32be, then salts/checksums
 *   N frames       — 24-byte frame header + one page of `pageSize` bytes each
 */

import * as fs from "fs";

const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const WAL_PAGE_SIZE_OFFSET = 8;

/** Big-endian magic; the low bit selects frame checksum endianness, not layout. */
const WAL_MAGIC_MASK = 0xfffffffe;
const WAL_MAGIC = 0x377f0682;

const MIN_PAGE_SIZE = 512;
const MAX_PAGE_SIZE = 65536;

export interface ReplicaWalShape {
  /** The `-wal` file is present on disk. */
  exists: boolean;
  sizeBytes: number;
  /** Page size from the WAL header; 0 when the header could not be read. */
  pageSizeBytes: number;
  /** Frames physically present in the WAL. Only meaningful when `frameCountKnown`. */
  frameCount: number;
  /**
   * We can state `frameCount` with confidence.
   *
   * False for a WAL we cannot parse (bad magic, implausible page size, truncated
   * header). A parse failure is *not* evidence of zero frames, and treating it as
   * such would delete healthy sidecars — callers must not infer a wedge from it.
   */
  frameCountKnown: boolean;
}

function isPlausiblePageSize(value: number): boolean {
  // SQLite encodes 65536 as 1 in the *database* header. The WAL header carries a
  // full u32, but accept the encoded form too rather than reject a valid WAL.
  const pageSize = value === 1 ? MAX_PAGE_SIZE : value;
  if (pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
    return false;
  }
  return (pageSize & (pageSize - 1)) === 0;
}

function normalizePageSize(value: number): number {
  return value === 1 ? MAX_PAGE_SIZE : value;
}

/**
 * Read `data.db-wal` and report how many frames it actually holds.
 *
 * Never throws — an unreadable WAL yields `frameCountKnown: false` so callers
 * fall back to leaving the sidecars alone.
 */
export function readReplicaWalShape(dbPath: string): ReplicaWalShape {
  const walPath = `${dbPath}-wal`;

  let sizeBytes: number;
  try {
    sizeBytes = fs.statSync(walPath).size;
  } catch {
    // No WAL file at all: definitively zero frames. The engine recreates it.
    return {
      exists: false,
      sizeBytes: 0,
      pageSizeBytes: 0,
      frameCount: 0,
      frameCountKnown: true,
    };
  }

  if (sizeBytes < WAL_HEADER_BYTES) {
    // Includes the common 0-byte case left behind by a checkpoint.
    return {
      exists: true,
      sizeBytes,
      pageSizeBytes: 0,
      frameCount: 0,
      frameCountKnown: true,
    };
  }

  const header = Buffer.alloc(WAL_HEADER_BYTES);
  let fd: number | null = null;
  try {
    fd = fs.openSync(walPath, "r");
    const read = fs.readSync(fd, header, 0, WAL_HEADER_BYTES, 0);
    if (read < WAL_HEADER_BYTES) {
      return {
        exists: true,
        sizeBytes,
        pageSizeBytes: 0,
        frameCount: 0,
        frameCountKnown: false,
      };
    }
  } catch {
    return {
      exists: true,
      sizeBytes,
      pageSizeBytes: 0,
      frameCount: 0,
      frameCountKnown: false,
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }

  const magic = header.readUInt32BE(0);
  const rawPageSize = header.readUInt32BE(WAL_PAGE_SIZE_OFFSET);

  if (
    (magic & WAL_MAGIC_MASK) !== WAL_MAGIC ||
    !isPlausiblePageSize(rawPageSize)
  ) {
    return {
      exists: true,
      sizeBytes,
      pageSizeBytes: 0,
      frameCount: 0,
      frameCountKnown: false,
    };
  }

  const pageSizeBytes = normalizePageSize(rawPageSize);
  const frameStride = WAL_FRAME_HEADER_BYTES + pageSizeBytes;
  const frameCount = Math.floor((sizeBytes - WAL_HEADER_BYTES) / frameStride);

  return {
    exists: true,
    sizeBytes,
    pageSizeBytes,
    frameCount,
    frameCountKnown: true,
  };
}
