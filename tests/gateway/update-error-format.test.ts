import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { formatUpdateError } = require("../../src/electron/updateErrorFormat.cjs") as {
  formatUpdateError: (m: unknown) => { error: string; recoveryHint?: string; transient?: boolean };
};
const { mergeUpdateStatusCache } = require("../../src/electron/updaterStatusCache.cjs") as {
  mergeUpdateStatusCache: (c: { status: string } | null, n: { status: string; transient?: boolean }) => { status: string };
};

// Seen in the wild on v2.7.6 (GitHub overloaded): electron-updater dumps the whole request.
const GITHUB_529 =
  '529 "method: GET url: https://github.com/Papr-ai/paprwork/releases.atom\\n\\n Data:\\n \\n " ' +
  'Headers: { "content-length": "0", "strict-transport-security": "max-age=31536000; includeSubDomains; preload" }';

describe("formatUpdateError", () => {
  it("turns a GitHub 529 dump into a short, transient message", () => {
    const out = formatUpdateError(GITHUB_529);
    expect(out.transient).toBe(true);
    expect(out.error).toBe("GitHub is busy right now, so the update check didn't go through (error 529).");
    expect(out.error).not.toMatch(/Headers|releases\.atom|strict-transport/);
    expect(out.recoveryHint).toMatch(/try again on its own/);
  });

  it.each([500, 502, 503, 429])("treats HTTP %i as transient", (code) => {
    expect(formatUpdateError(`HttpError: ${code} "method: GET url: x"`).transient).toBe(true);
  });

  it("network failures are transient and drop the raw text", () => {
    const out = formatUpdateError("net::ERR_INTERNET_DISCONNECTED");
    expect(out).toMatchObject({ error: "Could not reach the update server.", transient: true });
  });

  it("install failures are not transient and keep the recovery hint", () => {
    const out = formatUpdateError("ShipIt: code signature invalid");
    expect(out.transient).toBeUndefined();
    expect(out.recoveryHint).toMatch(/ShipIt/);
  });

  it("unknown errors keep only the first line", () => {
    expect(formatUpdateError("boom\n at stack line 1\n at 2").error).toBe("boom");
  });
});

describe("updater cache with transient errors", () => {
  it("a transient error never hides a downloaded update", () => {
    const ready = { status: "ready" };
    expect(mergeUpdateStatusCache(ready, { status: "error", transient: true })).toBe(ready);
  });
  it("a real error still replaces it", () => {
    expect(mergeUpdateStatusCache({ status: "ready" }, { status: "error" }).status).toBe("error");
  });
});
