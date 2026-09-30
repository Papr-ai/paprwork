import { describe, expect, it } from "vitest";
import {
  buildPlaywrightCookiesFromKeychainValues,
  chromePuppeteerToPlaywright,
  filterRequiredPlaywrightCookies,
  getPlaywrightCookieDomain,
  hasRequiredPlaywrightCookies,
  repairPlaywrightCookieDomains,
  syncPlaywrightCookieValuesFromKeychain,
} from "../src/gateway/services/platforms/platformCookieUtils.js";
import type { PlatformConfig } from "../src/gateway/services/platforms/platformRegistry.js";

const linkedinConfig = {
  id: "linkedin",
  name: "LinkedIn",
  cookieDomain: ".linkedin.com",
  cookieDomainOverrides: {
    li_at: ".linkedin.com",
    JSESSIONID: ".www.linkedin.com",
  },
  requiredCookies: ["li_at", "JSESSIONID"],
} as PlatformConfig;

describe("platformCookieUtils", () => {
  it("preserves Chrome host_key as Playwright domain", () => {
    const cookie = chromePuppeteerToPlaywright({
      name: "JSESSIONID",
      value: "ajax:123",
      domain: ".www.linkedin.com",
      path: "/",
      HttpOnly: false,
      Secure: true,
    });

    expect(cookie.domain).toBe(".www.linkedin.com");
    expect(cookie.secure).toBe(true);
    expect(cookie.expires).toBe(-1);
  });

  it("uses per-cookie domain overrides for keychain fallback", () => {
    const cookies = buildPlaywrightCookiesFromKeychainValues(linkedinConfig, {
      li_at: "token",
      JSESSIONID: "ajax:123",
    });

    expect(cookies).toHaveLength(2);
    expect(cookies.find((c) => c.name === "li_at")?.domain).toBe(".linkedin.com");
    expect(cookies.find((c) => c.name === "JSESSIONID")?.domain).toBe(
      ".www.linkedin.com",
    );
  });

  it("getPlaywrightCookieDomain falls back to cookieDomain", () => {
    expect(getPlaywrightCookieDomain(linkedinConfig, "bcookie")).toBe(".linkedin.com");
  });

  it("filterRequiredPlaywrightCookies keeps only required names", () => {
    const filtered = filterRequiredPlaywrightCookies(
      [
        { name: "li_at", value: "a", domain: ".linkedin.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
        { name: "bcookie", value: "b", domain: ".linkedin.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
        { name: "JSESSIONID", value: "c", domain: ".www.linkedin.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
      ],
      linkedinConfig,
    );

    expect(filtered.map((c) => c.name)).toEqual(["li_at", "JSESSIONID"]);
  });

  it("hasRequiredPlaywrightCookies is case-insensitive", () => {
    expect(
      hasRequiredPlaywrightCookies(
        [
          { name: "LI_AT", value: "a", domain: ".linkedin.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
          { name: "jsessionid", value: "b", domain: ".www.linkedin.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
        ],
        ["li_at", "JSESSIONID"],
      ),
    ).toBe(true);
  });

  it("repairs stale cookie domains using keychain overrides", () => {
    const { cookies, repaired } = repairPlaywrightCookieDomains(
      [
        {
          name: "li_at",
          value: "token",
          domain: ".linkedin.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
        {
          name: "JSESSIONID",
          value: "ajax:123",
          domain: ".linkedin.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        },
      ],
      linkedinConfig,
      { li_at: "token", JSESSIONID: "ajax:123" },
    );

    expect(repaired).toBe(true);
    expect(cookies.find((c) => c.name === "JSESSIONID")?.domain).toBe(
      ".www.linkedin.com",
    );
  });

  it("syncPlaywrightCookieValuesFromKeychain prefers fresher keychain values", () => {
    const cookies = buildPlaywrightCookiesFromKeychainValues(linkedinConfig, {
      li_at: "stale-token",
      JSESSIONID: "old-session",
    });
    const { cookies: synced, valuesChanged } = syncPlaywrightCookieValuesFromKeychain(
      cookies,
      { li_at: "fresh-token", JSESSIONID: "old-session" },
    );

    expect(valuesChanged).toBe(true);
    expect(synced.find((c) => c.name === "li_at")?.value).toBe("fresh-token");
    expect(synced.find((c) => c.name === "JSESSIONID")?.value).toBe("old-session");
  });
});
