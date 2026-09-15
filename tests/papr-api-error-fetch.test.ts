// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("papr-api-error-fetch", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as Window & { __paprApiErrorFetchInstalled?: boolean })
      .__paprApiErrorFetchInstalled;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rewrites failed /api responses with JSON error body", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "no such table: items" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-api-error-fetch.js");

    const res = await window.fetch("/api/db/query", { method: "POST" });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Request failed (500): no such table: items");
  });

  it("passes through successful responses unchanged", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows: [{ id: 1 }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-api-error-fetch.js");

    const res = await window.fetch("/api/db/query", { method: "POST" });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { rows?: unknown[] };
    expect(json.rows).toHaveLength(1);
  });
});
