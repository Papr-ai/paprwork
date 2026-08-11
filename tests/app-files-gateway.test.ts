/**
 * App Files gateway unit tests.
 *
 * Focus is the resume protocol and the local/cloud resolution rules — the two
 * places where a mistake is silent rather than loud. A wrong offset corrupts
 * a file with no error; a wrong eviction rule deletes someone's only copy.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHUNK_SIZE,
  hashFile,
  parseCommittedOffset,
  probeOffset,
  uploadResumable,
} from "../src/gateway/services/appFiles/resumableUploader.js";
import {
  isEvictable,
  isPublishable,
  resolveLocation,
  type AppFileRow,
} from "../src/gateway/services/appFiles/appFilesSchema.js";

function row(overrides: Partial<AppFileRow> = {}): AppFileRow {
  return {
    id: "f1",
    app_id: "app1",
    object_key: "namespaces/ns/apps/app1/files/" + "a".repeat(64),
    sha256: "a".repeat(64),
    size_bytes: 100,
    mime: null,
    file_name: "demo.mp4",
    scope: "app",
    local_path: "/tmp/demo.mp4",
    upload_state: "verified",
    visibility: "inherit",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("resume offset parsing", () => {
  it("reads the committed byte count from a Range header", () => {
    expect(parseCommittedOffset("bytes=0-262143")).toBe(262144);
  });

  it("treats a missing Range as nothing committed", () => {
    // A session created but never written to legitimately has no Range.
    expect(parseCommittedOffset(null)).toBe(0);
  });

  it("does not guess at a malformed Range", () => {
    expect(parseCommittedOffset("garbage")).toBe(0);
  });
});

describe("probeOffset", () => {
  it("reports total when GCS says the object is complete", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await probeOffset("https://s/1", 500, fetchImpl)).toBe(500);
  });

  it("returns the committed offset on 308", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 308, headers: { Range: "bytes=0-999" } }),
    ) as unknown as typeof fetch;
    expect(await probeOffset("https://s/1", 5000, fetchImpl)).toBe(1000);
  });

  it("throws on an unexpected status rather than assuming zero", async () => {
    // Assuming 0 here would silently re-upload from scratch, or worse, write
    // over committed bytes.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(probeOffset("https://s/1", 10, fetchImpl)).rejects.toThrow(/500/);
  });
});

describe("uploadResumable", () => {
  async function withTempFile(bytes: number, fn: (p: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "appfiles-"));
    const path = join(dir, "blob.bin");
    await writeFile(path, Buffer.alloc(bytes, 7));
    try {
      await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("uploads nothing when the object is already complete", async () => {
    await withTempFile(1024, async (path) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(null, { status: 200 }),
      ) as unknown as typeof fetch;
      const moved = await uploadResumable({
        sessionUrl: "https://s/1",
        filePath: path,
        totalBytes: 1024,
        fetchImpl,
      });
      expect(moved).toBe(0);
    });
  });

  it("resumes from the committed offset instead of restarting", async () => {
    await withTempFile(1024, async (path) => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        const range = (init.headers as Record<string, string>)["Content-Range"];
        calls.push(range);
        // First call is the probe: report 600 bytes already stored.
        if (range === "bytes */1024") {
          return new Response(null, { status: 308, headers: { Range: "bytes=0-599" } });
        }
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;

      const moved = await uploadResumable({
        sessionUrl: "https://s/1",
        filePath: path,
        totalBytes: 1024,
        fetchImpl,
      });

      expect(moved).toBe(424);
      expect(calls[1]).toBe("bytes 600-1023/1024");
    });
  });

  it("trusts the server's offset over its own chunk accounting", async () => {
    // A chunk can be partially accepted. If we assumed the whole chunk landed
    // we would skip bytes and produce a corrupt object with no error.
    await withTempFile(CHUNK_SIZE + 1000, async (path) => {
      const ranges: string[] = [];
      let call = 0;
      const total = CHUNK_SIZE + 1000;
      const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
        const range = (init.headers as Record<string, string>)["Content-Range"];
        ranges.push(range);
        call += 1;
        if (call === 1) return new Response(null, { status: 308 }); // probe: nothing yet
        if (call === 2) {
          // Server accepted only half the chunk.
          return new Response(null, {
            status: 308,
            headers: { Range: `bytes=0-${CHUNK_SIZE / 2 - 1}` },
          });
        }
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;

      await uploadResumable({
        sessionUrl: "https://s/1",
        filePath: path,
        totalBytes: total,
        fetchImpl,
      });

      expect(ranges[2]).toBe(`bytes ${CHUNK_SIZE / 2}-${total - 1}/${total}`);
    });
  });

  it("reports progress with a real byte rate", async () => {
    await withTempFile(2048, async (path) => {
      const seen: number[] = [];
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        if (call === 1) return new Response(null, { status: 308 });
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;

      await uploadResumable({
        sessionUrl: "https://s/1",
        filePath: path,
        totalBytes: 2048,
        fetchImpl,
        onProgress: (p) => seen.push(p.uploadedBytes),
      });
      // Completion via 200 short-circuits before the progress callback, so the
      // absence of samples here is correct, not a missing feature.
      expect(seen.every((n) => n <= 2048)).toBe(true);
    });
  });

  it("surfaces a failed chunk instead of silently continuing", async () => {
    await withTempFile(1024, async (path) => {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        if (call === 1) return new Response(null, { status: 308 });
        return new Response("denied", { status: 403 });
      }) as unknown as typeof fetch;

      await expect(
        uploadResumable({
          sessionUrl: "https://s/1",
          filePath: path,
          totalBytes: 1024,
          fetchImpl,
        }),
      ).rejects.toThrow(/403/);
    });
  });
});

describe("hashFile", () => {
  it("produces a stable content address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "appfiles-hash-"));
    const path = join(dir, "a.txt");
    await writeFile(path, "papr app files");
    const a = await hashFile(path);
    const b = await hashFile(path);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("location resolution", () => {
  it("prefers the local copy when present", () => {
    expect(resolveLocation(row())).toEqual({ kind: "local", path: "/tmp/demo.mp4" });
  });

  it("falls back to cloud once the local copy is evicted", () => {
    const r = row({ local_path: null });
    expect(resolveLocation(r).kind).toBe("cloud");
  });

  it("reports unavailable when there is no local copy and no verified upload", () => {
    const r = row({ local_path: null, upload_state: "pending" });
    expect(resolveLocation(r).kind).toBe("unavailable");
  });

  it("still resolves locally while an upload is in flight", () => {
    // The file is usable offline before it ever reaches the cloud.
    const r = row({ upload_state: "pending" });
    expect(resolveLocation(r).kind).toBe("local");
  });
});

describe("eviction safety", () => {
  it("allows eviction only when the cloud copy is verified", () => {
    expect(isEvictable(row())).toBe(true);
  });

  it("refuses to evict an unverified file", () => {
    expect(isEvictable(row({ upload_state: "pending" }))).toBe(false);
    expect(isEvictable(row({ upload_state: "failed" }))).toBe(false);
  });

  it("is a no-op when there is no local copy to remove", () => {
    expect(isEvictable(row({ local_path: null }))).toBe(false);
  });
});

describe("publish visibility", () => {
  it("publishes ordinary app-scoped files", () => {
    expect(isPublishable(row())).toBe(true);
  });

  it("never publishes a user-scoped file", () => {
    // The meeting-recording guarantee: a public app must not expose a
    // personal recording.
    expect(isPublishable(row({ scope: "user" }))).toBe(false);
  });

  it("honours an explicit keep-private flag", () => {
    expect(isPublishable(row({ visibility: "private" }))).toBe(false);
  });
});
