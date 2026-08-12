import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  getCloudAppHostAuth0Config,
  buildAuth0AuthorizeUrl,
  decodeIdToken,
  extractParseSessionFromIdToken,
} from "../src/core/utils/paprAuth0Pkce.js";
import {
  buildSessionCookie,
  readCloudAppSessionFromCookie,
  readSessionTokenFromCookie,
  buildShareTokenCookie,
  readShareTokenFromCookie,
  stripShareTokenFromPath,
  buildAuthPendingCookie,
  readAuthPendingCookie,
  sanitizeReturnToPath,
  isBrowsableCloudReturnToPath,
  resolveCloudAuthReturnToPath,
  resolveCloudAuthReturnToFromRequest,
  cloudAppRootPath,
  getSessionCookieDiagnostics,
  clearLegacySessionCookies,
} from "../src/gateway/services/appRuntime/cloudAppHostCookies.js";
import {
  visibilityRequiresPaprLogin,
  visibilityRequiresShareToken,
} from "../src/gateway/services/appRuntime/cloudAppPublishClient.js";

describe("paprAuth0Pkce", () => {
  it("builds authorize URL with redirect URI for cloud host", () => {
    const verifier = generateCodeVerifier();
    const config = getCloudAppHostAuth0Config("https://apps.papr.ai");
    const url = buildAuth0AuthorizeUrl(config, {
      state: "abc123",
      codeChallenge: generateCodeChallenge(verifier),
      mode: "login",
    });
    expect(url.hostname).toBe("papr.auth0.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://apps.papr.ai/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("extracts Parse session claims from JWT payload", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://papr.scope.com/sessionToken": "sess_abc",
        "https://papr.scope.com/objectId": "user_123",
        email: "dev@papr.ai",
      }),
      "utf8",
    ).toString("base64url");
    const token = `header.${payload}.sig`;
    const claims = extractParseSessionFromIdToken(decodeIdToken(token));
    expect(claims.sessionToken).toBe("sess_abc");
    expect(claims.objectId).toBe("user_123");
    expect(claims.email).toBe("dev@papr.ai");
  });
});

describe("cloudAppHostCookies", () => {
  const previousKey = process.env.PAPR_CLOUD_APP_HOST_KEY;

  beforeEach(() => {
    process.env.PAPR_CLOUD_APP_HOST_KEY = "test-host-key";
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.PAPR_CLOUD_APP_HOST_KEY;
    } else {
      process.env.PAPR_CLOUD_APP_HOST_KEY = previousKey;
    }
  });

  it("round-trips session cookie at site root", () => {
    const cookie = buildSessionCookie("sess_secret", false, "visitor-abc");
    expect(cookie).toContain("Path=/");
    const cookiePair = cookie.split(";")[0];
    const stored = readCloudAppSessionFromCookie(cookiePair);
    expect(stored?.sessionToken).toBe("sess_secret");
    expect(stored?.externalUserId).toBe("visitor-abc");
    expect(readSessionTokenFromCookie(cookiePair)).toBe("sess_secret");
  });

  it("clears legacy session cookies at / and /auth", () => {
    const cleared = clearLegacySessionCookies(false);
    expect(cleared).toHaveLength(2);
    expect(cleared[0]).toContain("Path=/");
    expect(cleared[1]).toContain("Path=/auth");
  });

  it("stores share token at site root for /api/db access", () => {
    const cookie = buildShareTokenCookie("share_tok", "ns1", "my-app", false);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    const cookiePair = cookie.split(";")[0];
    const header = `${cookiePair}; other=1`;
    expect(readShareTokenFromCookie(header, "ns1", "my-app")).toBe("share_tok");
    expect(readShareTokenFromCookie(header, "ns1", "other-app")).toBeUndefined();
  });

  it("uses SameSite=None for secure share token cookies (iframe embeds)", () => {
    const cookie = buildShareTokenCookie("share_tok", "ns1", "my-app", true);
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
  });

  it("round-trips auth pending cookie at site root", () => {
    const cookie = buildAuthPendingCookie(
      { state: "state1", codeVerifier: "verifier1", returnTo: "/ns/app" },
      false,
    );
    expect(cookie).toContain("Path=/");
    const cookiePair = cookie.split(";")[0];
    const pending = readAuthPendingCookie(cookiePair);
    expect(pending?.state).toBe("state1");
    expect(pending?.codeVerifier).toBe("verifier1");
    expect(pending?.returnTo).toBe("/ns/app");
  });

  it("trims signing secret whitespace from env", () => {
    process.env.PAPR_CLOUD_APP_HOST_KEY = "  test-host-key  ";
    const cookie = buildSessionCookie("sess_trim", false);
    const cookiePair = cookie.split(";")[0];
    expect(readSessionTokenFromCookie(cookiePair)).toBe("sess_trim");
  });

  it("reports session cookie diagnostics without leaking values", () => {
    const cookie = buildSessionCookie("sess_diag", false);
    const cookiePair = cookie.split(";")[0];
    const diagnostics = getSessionCookieDiagnostics(cookiePair);
    expect(diagnostics.sessionCookiePresent).toBe(true);
    expect(diagnostics.sessionCookieValid).toBe(true);
    expect(diagnostics.authPendingPresent).toBe(false);
  });

  it("strips share token query param", () => {
    expect(stripShareTokenFromPath("/ns/app?t=secret&x=1")).toBe("/ns/app/?x=1");
    expect(stripShareTokenFromPath("/ns/app?t=secret")).toBe("/ns/app/");
  });

  it("sanitizes returnTo paths", () => {
    expect(sanitizeReturnToPath("/ns/my-app")).toBe("/ns/my-app");
    expect(sanitizeReturnToPath("https://evil.com")).toBe("/");
    expect(sanitizeReturnToPath("//evil.com")).toBe("/");
  });

  it("rejects API and auth paths as return targets", () => {
    expect(isBrowsableCloudReturnToPath("/api/app-agent/sessions/abc")).toBe(false);
    expect(isBrowsableCloudReturnToPath("/auth/callback")).toBe(false);
    expect(isBrowsableCloudReturnToPath("/ns/my-app/")).toBe(true);
  });

  it("resolves auth returnTo to app root when API path is provided", () => {
    expect(
      resolveCloudAuthReturnToPath("/api/app-agent/sessions/sess-1/warm", {
        namespaceId: "ns1",
        slug: "demo-app",
      }),
    ).toBe("/ns1/demo-app/");
    expect(cloudAppRootPath("ns1", "demo-app")).toBe("/ns1/demo-app/");
  });

  it("prefers referer app page over API originalUrl", () => {
    const returnTo = resolveCloudAuthReturnToFromRequest(
      {
        originalUrl: "/api/app-agent/sessions/sess-1/messages",
        headers: { referer: "https://apps.papr.ai/ns1/demo-app/" },
      },
      { namespaceId: "ns1", slug: "demo-app" },
    );
    expect(returnTo).toBe("/ns1/demo-app/");
  });
});

describe("cloudAppPublishClient visibility helpers", () => {
  it("flags login-required modes", () => {
    expect(visibilityRequiresPaprLogin("private")).toBe(true);
    expect(visibilityRequiresPaprLogin("team")).toBe(true);
    expect(visibilityRequiresPaprLogin("public_read")).toBe(false);
    expect(visibilityRequiresPaprLogin("public_read", true)).toBe(true);
  });

  it("flags share-link modes", () => {
    expect(visibilityRequiresShareToken("link_read")).toBe(true);
    expect(visibilityRequiresShareToken("team")).toBe(false);
  });
});
