/**
 * Tests for the mini-app App Files SDK.
 *
 * The SDK runs in a browser, so these exercise it against fake fetch endpoints
 * with real Blobs. The property that matters most: bytes go straight to
 * storage, chunked, and never through the gateway.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { papr } from "../../../src/resources/mini-app-sdk/papr-files.js";

const CHUNK = 8 * 1024 * 1024;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function gcsResponse(status: number, range?: string): Response {
  return {
    ok: status < 400,
    status,
    json: async () => ({}),
    text: async () => "",
    headers: { get: (h: string) => (h === "Range" ? (range ?? null) : null) },
  } as unknown as Response;
}

interface Harness {
  gatewayCalls: string[];
  gcsBytes: number;
  restore: () => void;
}

/**
 * Fake gateway + fake GCS.
 *
 * Deliberately separate counters: an assertion that the gateway never saw the
 * payload is the point of the architecture, so the test has to be able to tell
 * the two apart.
 */
function harness(opts: { total: number; failChunk?: number }): Harness {
  const gatewayCalls: string[] = [];
  let committed = 0;
  let chunkCalls = 0;

  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";

    if (url.startsWith("/api/")) {
      gatewayCalls.push(`${method} ${url}`);
      if (url === "/api/files/ticket") {
        return jsonResponse({
          id: "file-1",
          objectKey: "namespaces/n/apps/a/files/sha",
          uploadUrl: "https://storage.googleapis.test/session",
          alreadyExists: false,
          sha256: "sha",
        });
      }
      if (url === "/api/files/commit") {
        return jsonResponse({
          id: "file-1",
          objectKey: "namespaces/n/apps/a/files/sha",
          sha256: "sha",
          sizeBytes: opts.total,
          deduped: false,
          verified: true,
        });
      }
      if (url === "/api/files/url") {
        return jsonResponse({
          location: { kind: "cloud" },
          url: "https://files.papr.ai/obj",
        });
      }
      if (url === "/api/files") {
        return jsonResponse({ files: [{ id: "file-1", file_name: "a.mp4" }] });
      }
      if (url === "/api/files/delete") return jsonResponse({ deleted: true });
    }

    // Anything else is the storage endpoint.
    const range = (init?.headers as Record<string, string>)?.["Content-Range"];
    if (range?.startsWith("bytes */")) {
      return committed === 0
        ? gcsResponse(308)
        : gcsResponse(308, `bytes=0-${committed - 1}`);
    }

    chunkCalls += 1;
    if (opts.failChunk && chunkCalls === opts.failChunk) {
      return gcsResponse(503);
    }

    const m = /bytes (\d+)-(\d+)\//.exec(range ?? "");
    committed = Number(m?.[2]) + 1;
    return committed >= opts.total
      ? gcsResponse(200)
      : gcsResponse(308, `bytes=0-${committed - 1}`);
  };

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
  return {
    gatewayCalls,
    get gcsBytes() {
      return committed;
    },
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("papr.files.upload", () => {
  it("uploads a multi-chunk blob and verifies it server-side", async () => {
    const total = CHUNK * 2 + 512;
    const h = harness({ total });
    const blob = new Blob([new Uint8Array(total)]);

    const result = await papr.files.upload(blob, { name: "recording.mp4" });

    expect(result.verified).toBe(true);
    expect(h.gcsBytes).toBe(total);
    h.restore();
  });

  it("never sends the payload through the gateway", async () => {
    // The whole reason for browser-direct upload: a relayed 10 GB file would
    // cost the gateway memory or disk proportional to the file.
    const total = CHUNK + 100;
    const h = harness({ total });

    await papr.files.upload(new Blob([new Uint8Array(total)]), { name: "v.mp4" });

    // Only control-plane calls — a ticket and a commit. No byte-carrying POST.
    expect(h.gatewayCalls).toEqual([
      "POST /api/files/ticket",
      "POST /api/files/commit",
    ]);
    h.restore();
  });

  it("retries a transient storage failure without restarting the upload", async () => {
    const total = CHUNK * 2;
    const h = harness({ total, failChunk: 2 });

    const result = await papr.files.upload(new Blob([new Uint8Array(total)]), {
      name: "v.mp4",
    });

    expect(result.verified).toBe(true);
    expect(h.gcsBytes).toBe(total);
    h.restore();
  });

  it("reports progress as bytes land", async () => {
    const total = CHUNK * 2 + 10;
    const h = harness({ total });
    const seen: number[] = [];

    await papr.files.upload(new Blob([new Uint8Array(total)]), {
      name: "v.mp4",
      onProgress: (p) => seen.push(p.uploadedBytes),
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(total);
    // Monotonic — progress that jumps backwards reads as a stall to the user.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    h.restore();
  });

  it("skips the transfer entirely when the bytes already exist", async () => {
    // Content addressing means re-uploading the same recording is free — a
    // better saving than any compression ratio.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: string,
    ) => {
      if (url === "/api/files/ticket") {
        return jsonResponse({
          id: "file-1",
          objectKey: "k",
          uploadUrl: null,
          alreadyExists: true,
          sha256: "sha",
        });
      }
      throw new Error(`unexpected call to ${url}`);
    }) as never);

    const result = await papr.files.upload(new Blob([new Uint8Array(1024)]), {
      name: "dupe.mp4",
    });

    expect(result.deduped).toBe(true);
    expect(result.verified).toBe(true);
    spy.mockRestore();
  });

  it("stops immediately when aborted", async () => {
    const total = CHUNK * 4;
    const h = harness({ total });
    const controller = new AbortController();
    controller.abort();

    await expect(
      papr.files.upload(new Blob([new Uint8Array(total)]), {
        name: "v.mp4",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    h.restore();
  });
});

describe("papr.files url/list/remove", () => {
  it("resolves a file to a loadable URL", async () => {
    const h = harness({ total: 1 });
    const res = await papr.files.url("file-1");
    expect(res.url).toBe("https://files.papr.ai/obj");
    expect(res.location).toBe("cloud");
    h.restore();
  });

  it("lists files without the app naming itself", async () => {
    // appId is inferred server-side from the request, so app code never
    // hardcodes its own UUID.
    const h = harness({ total: 1 });
    const files = await papr.files.list();
    expect(files).toHaveLength(1);
    expect(h.gatewayCalls).toContain("GET /api/files");
    h.restore();
  });

  it("removes a file", async () => {
    const h = harness({ total: 1 });
    expect(await papr.files.remove("file-1")).toBe(true);
    h.restore();
  });
});
