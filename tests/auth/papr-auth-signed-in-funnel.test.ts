/**
 * After desktop sign-in, the local success page continues to
 * papr.ai/desktop/signed-in?install=<id> so PostHog can link the papr.ai
 * visitor (who downloaded the app) to this install. Only the random install id
 * is in the query; the backup code stays in the fragment.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildPaprAuthSuccessHtml,
  buildPaprSignedInUrl,
  paprSignedInFunnel,
  PAPR_SIGNED_IN_URL,
} from "../../src/electron/ipc/paprAuthCallbackServer.js";

const INSTALL = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

function settings(overrides: Partial<{ enabled: boolean; id: string; throws: boolean }> = {}) {
  return {
    getTelemetryEnabled: () => {
      if (overrides.throws) throw new Error("store unavailable");
      return overrides.enabled ?? true;
    },
    getOrCreateTelemetryInstallId: () => overrides.id ?? INSTALL,
  };
}

describe("buildPaprSignedInUrl", () => {
  it("puts the install id in the query and the backup code in the fragment", () => {
    const url = new URL(buildPaprSignedInUrl({ installId: INSTALL }, "ABC-DEF")!);
    expect(`${url.origin}${url.pathname}`).toBe(PAPR_SIGNED_IN_URL);
    expect(url.searchParams.get("install")).toBe(INSTALL);
    expect(url.searchParams.has("code")).toBe(false);
    expect(url.hash).toBe("#code=ABC-DEF");
  });

  it("rejects anything that isn't a UUID install id", () => {
    expect(buildPaprSignedInUrl({ installId: "user@example.com" }, null)).toBeNull();
    expect(buildPaprSignedInUrl({ installId: "" }, null)).toBeNull();
  });
});

describe("paprSignedInFunnel", () => {
  afterEach(() => {
    delete process.env.PAPR_AUTH_SIGNED_IN_REDIRECT;
  });

  it("returns the install id for packaged builds with telemetry on", () => {
    expect(paprSignedInFunnel(settings(), true)).toEqual({ installId: INSTALL });
  });

  it("stays on the local page for dev builds, telemetry off, or the env opt-out", () => {
    expect(paprSignedInFunnel(settings(), false)).toBeNull();
    expect(paprSignedInFunnel(settings({ enabled: false }), true)).toBeNull();
    process.env.PAPR_AUTH_SIGNED_IN_REDIRECT = "false";
    expect(paprSignedInFunnel(settings(), true)).toBeNull();
  });

  it("never throws", () => {
    expect(paprSignedInFunnel(settings({ throws: true }), true)).toBeNull();
  });
});

describe("buildPaprAuthSuccessHtml", () => {
  it("without a funnel, is the plain local page (no papr.ai redirect)", () => {
    const html = buildPaprAuthSuccessHtml("ABCDEF");
    expect(html).toContain("You&apos;re signed in.");
    expect(html).toContain("ABC-DEF");
    expect(html).not.toContain("papr.ai/desktop/signed-in");
    expect(html).not.toContain("location.replace");
  });

  it("with a funnel, keeps the local page and continues to papr.ai only if it answers", () => {
    const html = buildPaprAuthSuccessHtml("ABCDEF", { installId: INSTALL });
    expect(html).toContain("You&apos;re signed in.");
    expect(html).toContain("ABC-DEF");
    expect(html).toContain(`papr.ai/desktop/signed-in?install=${INSTALL}#code=ABC-DEF`);
    expect(html).toContain("location.replace(target)");
    expect(html).toMatch(/setTimeout\(function \(\) \{ done = true; \}, 1500\)/);
  });
});
