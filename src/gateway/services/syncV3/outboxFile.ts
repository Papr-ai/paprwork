/**
 * Bounded reads for the Sync V3 outbox files.
 *
 * The outboxes are JSONL queues whose entries carry app file contents inline,
 * so one line can be hundreds of megabytes. Reading them with
 * `fs.readFile(path, "utf8")` materialises the whole file as a single JS string
 * and aborts the process once that passes V8's string ceiling: a 1.6GB outbox
 * killed the gateway on every launch, before any of it could be drained.
 *
 * Lines are therefore streamed as bytes and only decoded once a full line is in
 * hand and known to be under `maxLineBytes`. An oversized line is never turned
 * into a string — its bytes stream straight to a quarantine file so the entries
 * behind it can drain and the payload stays on disk for inspection.
 */

import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";

const NEWLINE = 0x0a;

/**
 * A single queued op. Above this, an entry cannot be pushed anyway.
 *
 * Set well above the collector's batch budget so JSON escaping cannot turn an
 * acceptable batch into an unwritable line.
 */
export const MAX_OUTBOX_LINE_BYTES = 16 * 1024 * 1024;

/** Whole queue. Above this, reading every entry to update one is too costly. */
export const MAX_OUTBOX_FILE_BYTES = 64 * 1024 * 1024;

export interface OversizedLine {
  /** 1-based line number in the source file. */
  lineNumber: number;
  byteLength: number;
}

export interface StreamJsonlHandlers {
  maxLineBytes: number;
  /** Called with each complete line under the cap, newline stripped. */
  onLine: (line: string, lineNumber: number) => void | Promise<void>;
  /** Called with raw bytes of an oversized line, in arrival order. */
  onOversizedChunk?: (chunk: Buffer) => void | Promise<void>;
  onOversizedEnd?: (info: OversizedLine) => void | Promise<void>;
}

/**
 * Walk a JSONL file line by line without ever holding an oversized line in
 * memory. Bytes of an oversized line are handed to `onOversizedChunk` as they
 * arrive and then dropped.
 */
export async function streamJsonlLines(
  filePath: string,
  handlers: StreamJsonlHandlers,
): Promise<void> {
  const { maxLineBytes, onLine, onOversizedChunk, onOversizedEnd } = handlers;

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overflowed = false;
  let lineNumber = 0;

  const finishLine = async (): Promise<void> => {
    lineNumber += 1;
    if (overflowed) {
      await onOversizedEnd?.({ lineNumber, byteLength: pendingBytes });
    } else if (pendingBytes > 0) {
      const text = Buffer.concat(pending).toString("utf8").trim();
      if (text.length > 0) {
        await onLine(text, lineNumber);
      }
    }
    pending = [];
    pendingBytes = 0;
    overflowed = false;
  };

  const takeSegment = async (segment: Buffer): Promise<void> => {
    if (segment.length === 0) {
      return;
    }
    pendingBytes += segment.length;
    if (overflowed || pendingBytes > maxLineBytes) {
      // Never accumulate: hand the bytes off and forget them.
      if (!overflowed) {
        for (const buffered of pending) {
          await onOversizedChunk?.(buffered);
        }
        pending = [];
        overflowed = true;
      }
      await onOversizedChunk?.(segment);
      return;
    }
    pending.push(segment);
  };

  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      let index = chunk.indexOf(NEWLINE, start);
      while (index !== -1) {
        await takeSegment(chunk.subarray(start, index));
        if (overflowed) {
          await onOversizedChunk?.(Buffer.from([NEWLINE]));
        }
        await finishLine();
        start = index + 1;
        index = chunk.indexOf(NEWLINE, start);
      }
      await takeSegment(chunk.subarray(start));
    }
  } catch (err) {
    stream.destroy();
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }

  if (pendingBytes > 0 || overflowed) {
    await finishLine();
  }
}

export interface BoundedJsonlRead {
  lines: string[];
  oversized: OversizedLine[];
}

/**
 * Read every line under the cap, skipping (and reporting) oversized ones.
 * Use this wherever a full `readFile` would otherwise be unbounded.
 */
export async function readJsonlBounded(
  filePath: string,
  maxLineBytes = MAX_OUTBOX_LINE_BYTES,
): Promise<BoundedJsonlRead> {
  const lines: string[] = [];
  const oversized: OversizedLine[] = [];
  await streamJsonlLines(filePath, {
    maxLineBytes,
    onLine: (line) => {
      lines.push(line);
    },
    onOversizedEnd: (info) => {
      oversized.push(info);
    },
  });
  return { lines, oversized };
}

export interface CompactResult {
  keptLines: number;
  quarantinedLines: number;
  quarantinedBytes: number;
}

/**
 * Rewrite a JSONL file without its oversized lines, moving their bytes to
 * `quarantinePath`. Both writes stream, so peak memory stays at one chunk.
 */
export async function compactJsonlDroppingOversized(
  filePath: string,
  options: {
    maxLineBytes?: number;
    quarantinePath: string;
  },
): Promise<CompactResult> {
  const maxLineBytes = options.maxLineBytes ?? MAX_OUTBOX_LINE_BYTES;
  const tmpPath = `${filePath}.compact-${process.pid}-${Date.now()}`;

  const kept = createWriteStream(tmpPath, { flags: "w" });
  const quarantine = createWriteStream(options.quarantinePath, { flags: "a" });

  const result: CompactResult = {
    keptLines: 0,
    quarantinedLines: 0,
    quarantinedBytes: 0,
  };

  const write = (
    stream: import("node:fs").WriteStream,
    data: string | Buffer,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.write(data, (err) => (err ? reject(err) : resolve()));
    });

  try {
    await streamJsonlLines(filePath, {
      maxLineBytes,
      onLine: async (line) => {
        await write(kept, `${line}\n`);
        result.keptLines += 1;
      },
      onOversizedChunk: async (chunk) => {
        await write(quarantine, chunk);
      },
      onOversizedEnd: (info) => {
        result.quarantinedLines += 1;
        result.quarantinedBytes += info.byteLength;
      },
    });
  } finally {
    await Promise.all([closeStream(kept), closeStream(quarantine)]);
  }

  if (result.quarantinedLines === 0) {
    await fs.rm(tmpPath, { force: true });
    return result;
  }

  await fs.rename(tmpPath, filePath);
  return result;
}

function closeStream(stream: import("node:fs").WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

/** Byte size of a file, or 0 when it does not exist. */
export async function fileBytes(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/** Copy a file with streams, so size does not bound memory. */
export async function copyFileStreaming(
  from: string,
  to: string,
): Promise<void> {
  await pipeline(createReadStream(from), createWriteStream(to));
}
