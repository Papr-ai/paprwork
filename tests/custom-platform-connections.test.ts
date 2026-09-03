import { describe, expect, it } from "vitest";
import {
  parsePlatformConnectionUrl,
  customRecordToPlatformConfig,
} from "../src/gateway/services/platforms/customPlatformConnections.js";

describe("parsePlatformConnectionUrl", () => {
  it("parses a full https URL into a site id", () => {
    const parsed = parsePlatformConnectionUrl("https://www.notion.so/my-workspace");
    expect(parsed.id).toBe("site-notion-so");
    expect(parsed.originHost).toBe("notion.so");
    expect(parsed.homeUrl).toBe("https://www.notion.so/my-workspace");
    expect(parsed.loginUrl).toBe("https://www.notion.so/");
    expect(parsed.cookieDomain).toBe(".notion.so");
  });

  it("accepts bare hostnames", () => {
    const parsed = parsePlatformConnectionUrl("github.com");
    expect(parsed.id).toBe("site-github-com");
    expect(parsed.homeUrl).toBe("https://github.com/");
  });

  it("uses a custom display name when provided", () => {
    const parsed = parsePlatformConnectionUrl("https://app.linear.app", "Linear");
    expect(parsed.name).toBe("Linear");
  });
});

describe("customRecordToPlatformConfig", () => {
  it("marks custom configs for embedded browser support", () => {
    const parsed = parsePlatformConnectionUrl("https://dashboard.stripe.com");
    const config = customRecordToPlatformConfig({
      ...parsed,
      registeredBy: "agent",
      registeredAt: new Date().toISOString(),
    });
    expect(config.isCustom).toBe(true);
    expect(config.requiredCookies).toEqual([]);
    expect(config.keyPrefix).toBe("SITE_DASHBOARD_STRIPE_COM");
  });
});
