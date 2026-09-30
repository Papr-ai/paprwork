import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildDesktopBridgeCookieBundle,
} from "../src/gateway/services/appRuntime/cloudAppHostDesktopBridge.js";
import {
  buildSessionCookie,
  readCloudAppSessionFromCookie,
} from "../src/gateway/services/appRuntime/cloudAppHostCookies.js";

describe("cloudAppHostDesktopBridge", () => {
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

  it("builds papr_session with SameSite=None for embedded desktop preview", () => {
    const bundle = buildDesktopBridgeCookieBundle({
      sessionToken: "sess_desktop",
      externalUserId: "user_abc",
      email: "dev@papr.ai",
      returnTo: "/ns-work/demo-app/",
      secure: true,
    });

    expect(bundle.redirectTo).toBe("/ns-work/demo-app/");
    const sessionHeader = bundle.setCookieHeaders.find((header) => {
      const pair = header.split(";")[0] ?? "";
      return pair.startsWith("papr_session=") && pair.length > "papr_session=".length;
    });
    expect(sessionHeader).toBeTruthy();
    expect(sessionHeader).toMatch(/SameSite=None/i);

    const cookiePair = sessionHeader!.split(";")[0];
    const stored = readCloudAppSessionFromCookie(cookiePair);
    expect(stored?.sessionToken).toBe("sess_desktop");
    expect(stored?.externalUserId).toBe("user_abc");
    expect(stored?.email).toBe("dev@papr.ai");

    const webLoginCookie = buildSessionCookie(
      "sess_desktop",
      true,
      "user_abc",
      "dev@papr.ai",
    );
    expect(webLoginCookie).toMatch(/SameSite=Lax/i);
    const webStored = readCloudAppSessionFromCookie(webLoginCookie.split(";")[0]);
    expect(webStored?.sessionToken).toBe("sess_desktop");
  });
});
