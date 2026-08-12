/**
 * Resumable upload to a GCS session URI.
 *
 * Ported from the recordings backup job, which moved a 6.70 GB file over ~21
 * minutes with a mid-flight interruption and verified clean. The behaviour is
 * proven; this is a transcription, not a redesign.
 *
 * Protocol notes that matter:
 *   - Chunks must be a multiple of 256 KiB except the final one. GCS rejects
 *     anything else mid-upload.
 *   - A 308 response means "still incomplete"; the Range header tells us how
 *     much GCS actually committed. We trust that number over our own count,
 *     because a chunk can be partially accepted.
 *   - The session URI stays valid for a week, so an interrupted upload can be
 *     resumed later without minting a new ticket.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

/** GCS requires multiples of 256 KiB; 8 MiB balances throughput and retries. */
export const CHUNK_SIZE = 8 * 1024 * 1024;

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  /** Null until we have enough samples to be honest about it. */
  etaSeconds: number | null;
}

export interface UploadOptions {
  sessionUrl: string;
  filePath: string;
  totalBytes: number;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Ask GCS how many bytes it already has for this session.
 *
 * Always call this before resuming: our local idea of progress can be wrong
 * after a crash, and GCS is the only authority on what was committed.
 */
export async function probeOffset(
  sessionUrl: string,
  totalBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Length": "0",
      "Content-Range": `bytes */${totalBytes}`,
    },
  });

  if (res.status === 200 || res.status === 201) return totalBytes;
  if (res.status !== 308) {
    throw new Error(`Unexpected status probing upload session: ${res.status}`);
  }
  return parseCommittedOffset(res.headers.get("Range"));
}

/**
 * Parse GCS's `Range: bytes=0-N` into the next byte to send.
 *
 * Absent header means nothing was committed — that is a legitimate answer for
 * a session that was created but never written to, not an error.
 */
export function parseCommittedOffset(rangeHeader: string | null): number {
  if (!rangeHeader) return 0;
  const match = /bytes=\d+-(\d+)/.exec(rangeHeader);
  if (!match) return 0;
  return Number(match[1]) + 1;
}

/** SHA-256 of a file, streamed so multi-GB inputs never land in memory. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function readChunk(
  filePath: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Upload a file to an existing session URI, resuming from wherever GCS is.
 *
 * Returns the number of bytes uploaded in this invocation (0 when the object
 * was already complete), so callers can distinguish "resumed and finished"
 * from "was already done".
 */
export async function uploadResumable(opts: UploadOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const total = opts.totalBytes;

  let offset = await probeOffset(opts.sessionUrl, total, fetchImpl);
  if (offset >= total) return 0;

  const startedAt = Date.now();
  const startOffset = offset;

  while (offset < total) {
    if (opts.signal?.aborted) {
      throw Object.assign(new Error("Upload aborted"), { uploadedBytes: offset });
    }

    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = await readChunk(opts.filePath, offset, end - offset);

    const res = await fetchImpl(opts.sessionUrl, {
      method: "PUT",
      body: new Uint8Array(chunk),
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${total}`,
      },
      signal: opts.signal,
    });

    if (res.status === 200 || res.status === 201) {
      offset = total;
      break;
    }
    if (res.status === 308) {
      // Trust GCS's committed offset rather than assuming the whole chunk
      // landed — a partially accepted chunk would otherwise leave a gap.
      const committed = parseCommittedOffset(res.headers.get("Range"));
      offset = committed > offset ? committed : end;
    } else {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Upload chunk failed (${res.status}) at offset ${offset}: ${text.slice(0, 200)}`,
      );
    }

    if (opts.onProgress) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const movedThisRun = offset - startOffset;
      const rate = elapsed > 0 ? movedThisRun / elapsed : 0;
      opts.onProgress({
        uploadedBytes: offset,
        totalBytes: total,
        bytesPerSecond: rate,
        etaSeconds: rate > 0 ? Math.round((total - offset) / rate) : null,
      });
    }
  }

  return offset - startOffset;
}

/** Confirm the local file is the size we told the server it was. */
export async function localSizeMatches(
  filePath: string,
  expected: number,
): Promise<boolean> {
  const info = await stat(filePath);
  return info.size === expected;
}
