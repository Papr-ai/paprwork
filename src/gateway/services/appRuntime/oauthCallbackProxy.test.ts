import { describe, expect, it } from "vitest";
import { callbackUpstreamUrl, safeRedirect } from "./oauthCallbackProxy.js";

describe("oauthCallbackProxy", () => {
  it("forwards only the OAuth params", () => {
    const url = callbackUpstreamUrl({ state: "s", code: "c", evil: "x", error: "" } as never, "https://m.example");
    expect(url).toBe("https://m.example/v1/cloud/oauth/callback?state=s&code=c");
  });

  it("passes through redirects back into Papr only", () => {
    expect(safeRedirect("papr://connections/signed-in?session=1")).toBe("papr://connections/signed-in?session=1");
    expect(safeRedirect("https://apps.papr.ai/x")).toBe("https://apps.papr.ai/x");
    expect(safeRedirect("https://evil.com/papr.ai/")).toBeNull();
    expect(safeRedirect("https://papr.ai.evil.com/")).toBeNull();
    expect(safeRedirect(null)).toBeNull();
  });
});
