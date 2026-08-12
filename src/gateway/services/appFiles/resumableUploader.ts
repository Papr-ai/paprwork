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

import {
  DEFAULT_RETRY,
  backoffDelayMs,
  shouldRetry,
  type RetryPolicy,
} from "./uploadResume.js";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  /** Overridable so tests do not actually sleep through the backoff. */
  sleepImpl?: (ms: number) => Promise<void>;
  retryPolicy?: RetryPolicy;
  /**
   * Called whenever GCS confirms a new committed offset, so the caller can
   * persist it. This is what makes a crash cost seconds instead of gigabytes.
   */
  onOffsetCommitted?: (offset: number) => void | Promise<void>;
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

interface ChunkDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  policy: RetryPolicy;
}

interface ChunkOutcome {
  /** GCS finalised the object — 200/201 rather than another 308. */
  complete: boolean;
  /** Bytes GCS says it has committed so far. */
  committed: number;
}

/**
 * PUT one chunk, retrying transient failures with backoff.
 *
 * A dropped connection throws rather than returning a status, so both paths
 * have to funnel into the same decision — otherwise the most common failure on
 * a flaky link (no response at all) would be the one case we do not retry.
 */
async function sendChunkWithRetry(
  opts: UploadOptions,
  chunk: Buffer,
  offset: number,
  total: number,
  deps: ChunkDeps,
): Promise<ChunkOutcome> {
  let attempt = 0;

  for (;;) {
    attempt += 1;
    let status: number | null = null;

    try {
      const res = await deps.fetchImpl(opts.sessionUrl, {
        method: "PUT",
        body: new Uint8Array(chunk),
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${total}`,
        },
        signal: opts.signal,
      });
      status = res.status;

      if (res.status === 200 || res.status === 201) {
        return { complete: true, committed: total };
      }
      if (res.status === 308) {
        return {
          complete: false,
          committed: parseCommittedOffset(res.headers.get("Range")),
        };
      }

      if (!shouldRetry(attempt, res.status, deps.policy)) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Upload chunk failed (${res.status}) at offset ${offset}: ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      // An aborted upload is a decision, not a failure — never retry it.
      if (opts.signal?.aborted) throw err;
      // A thrown error with a status we already judged unretryable is final.
      if (status !== null && !shouldRetry(attempt, status, deps.policy)) throw err;
      if (!shouldRetry(attempt, null, deps.policy)) throw err;
    }

    await deps.sleep(backoffDelayMs(attempt, deps.policy));
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
  const sleep = opts.sleepImpl ?? defaultSleep;
  const policy = opts.retryPolicy ?? DEFAULT_RETRY;
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

    // Retry the chunk, never the file. On a 10 GB upload a transient 503 at
    // 9 GB must cost one 8 MiB chunk, not the whole transfer.
    const outcome = await sendChunkWithRetry(opts, chunk, offset, total, {
      fetchImpl,
      sleep,
      policy,
    });

    if (outcome.complete) {
      offset = total;
      await opts.onOffsetCommitted?.(offset);
      break;
    }
    // Trust GCS's committed offset rather than assuming the whole chunk
    // landed — a partially accepted chunk would otherwise leave a gap.
    offset = outcome.committed > offset ? outcome.committed : end;
    await opts.onOffsetCommitted?.(offset);

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
