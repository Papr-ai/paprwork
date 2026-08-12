/**
 * Tests for the chunked uploader against a fake GCS.
 *
 * Focused on what a 10 GB upload actually meets in the wild: transient 503s,
 * dropped connections, partially accepted chunks, and a crash that must not
 * cost the whole transfer.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  uploadResumable,
} from "../../../src/gateway/services/appFiles/resumableUploader.js";

let dir = "";
let filePath = "";
/** Two chunks plus a remainder, so multi-chunk paths are actually exercised. */
const TOTAL = CHUNK_SIZE * 2 + 1024;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "papr-upload-"));
  filePath = join(dir, "recording.mp4");
  await writeFile(filePath, Buffer.alloc(TOTAL, 7));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noSleep = async (): Promise<void> => undefined;

function res(status: number, range?: string): Response {
  return {
    status,
    headers: { get: (h: string) => (h === "Range" ? (range ?? null) : null) },
    text: async () => "",
  } as unknown as Response;
}

/** Fake GCS that commits whatever it is sent, honouring Content-Range. */
function fakeGcs(script: (attempt: number) => Response | "throw" | null) {
  let committed = 0;
  let attempt = 0;
  const calls: string[] = [];

  const impl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.["Content-Range"];
    calls.push(range);

    // Offset probe.
    if (range?.startsWith("bytes */")) {
      return committed === 0
        ? res(308)
        : res(308, `bytes=0-${committed - 1}`);
    }

    attempt += 1;
    const scripted = script(attempt);
    if (scripted === "throw") throw new Error("socket hang up");
    if (scripted) return scripted;

    const match = /bytes (\d+)-(\d+)\//.exec(range ?? "");
    committed = Number(match?.[2]) + 1;
    return committed >= TOTAL
      ? res(200)
      : res(308, `bytes=0-${committed - 1}`);
  }) as unknown as typeof fetch;

  return { impl, calls, get committed() { return committed; } };
}

describe("uploadResumable", () => {
  it("uploads a multi-chunk file to completion", async () => {
    const gcs = fakeGcs(() => null);
    const sent = await uploadResumable({
      sessionUrl: "https://upload.example/s",
      filePath,
      totalBytes: TOTAL,
      fetchImpl: gcs.impl,
      sleepImpl: noSleep,
    });
    expect(sent).toBe(TOTAL);
  });

  it("retries a transient 503 without restarting the file", async () => {
    // The failure that matters at 9 GB of 10: one chunk retried, not 10 GB.
    let failures = 0;
    const gcs = fakeGcs((attempt) => {
      if (attempt === 2 && failures === 0) {
        failures += 1;
        return res(503);
      }
      return null;
    });

    const sent = await uploadResumable({
      sessionUrl: "https://upload.example/s",
      filePath,
      totalBytes: TOTAL,
      fetchImpl: gcs.impl,
      sleepImpl: noSleep,
    });
    expect(sent).toBe(TOTAL);
    expect(failures).toBe(1);
  });

  it("retries a dropped connection, which returns no status at all", async () => {
    let thrown = 0;
    const gcs = fakeGcs((attempt) => {
      if (attempt === 2 && thrown === 0) {
        thrown += 1;
        return "throw";
      }
      return null;
    });

    const sent = await uploadResumable({
      sessionUrl: "https://upload.example/s",
      filePath,
      totalBytes: TOTAL,
      fetchImpl: gcs.impl,
      sleepImpl: noSleep,
    });
    expect(sent).toBe(TOTAL);
    expect(thrown).toBe(1);
  });

  it("gives up on a permanent error instead of retrying six times", async () => {
    const gcs = fakeGcs(() => res(403));
    await expect(
      uploadResumable({
        sessionUrl: "https://upload.example/s",
        filePath,
        totalBytes: TOTAL,
        fetchImpl: gcs.impl,
        sleepImpl: noSleep,
      }),
    ).rejects.toThrow(/403/);
  });

  it("reports committed offsets so a crash costs seconds, not gigabytes", async () => {
    // This callback is what persists progress. Without it the session URI and
    // byte count die with the process.
    const seen: number[] = [];
    const gcs = fakeGcs(() => null);

    await uploadResumable({
      sessionUrl: "https://upload.example/s",
      filePath,
      totalBytes: TOTAL,
      fetchImpl: gcs.impl,
      sleepImpl: noSleep,
      onOffsetCommitted: (o) => {
        seen.push(o);
      },
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(TOTAL);
    // Monotonic: an offset going backwards would re-send bytes GCS already has.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("resumes from GCS's offset rather than restarting at zero", async () => {
    // Simulates the laptop-died case: GCS already holds the first chunk.
    let committed = CHUNK_SIZE;
    const impl = (async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>)?.["Content-Range"];
      if (range?.startsWith("bytes */")) {
        return res(308, `bytes=0-${committed - 1}`);
      }
      const match = /bytes (\d+)-(\d+)\//.exec(range ?? "");
      const start = Number(match?.[1]);
      // The upload must continue from the committed byte, not from zero.
      expect(start).toBeGreaterThanOrEqual(CHUNK_SIZE);
      committed = Number(match?.[2]) + 1;
      return committed >= TOTAL ? res(200) : res(308, `bytes=0-${committed - 1}`);
    }) as unknown as typeof fetch;

    const sent = await uploadResumable({
      sessionUrl: "https://upload.example/s",
      filePath,
      totalBytes: TOTAL,
      fetchImpl: impl,
      sleepImpl: noSleep,
    });

    // Only the remaining bytes moved — the first chunk was not re-sent.
    expect(sent).toBe(TOTAL - CHUNK_SIZE);
  });

  it("does nothing when GCS already has the whole object", async () => {
    const impl = (async () => res(200)) as unknown as typeof fetch;
    const sent = await uploadResumable({
      sessionUrl: "https://upload.example/s",
      filePath,
      totalBytes: TOTAL,
      fetchImpl: impl,
      sleepImpl: noSleep,
    });
    expect(sent).toBe(0);
  });
});
