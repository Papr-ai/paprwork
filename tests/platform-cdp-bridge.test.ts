import { describe, expect, it } from "vitest";
import {
  jobNeedsPlatformCdp,
  platformIdsFromRequirements,
  resolvePlatformCdpUrl,
} from "../src/gateway/utils/platformCdpBridge.js";

describe("platformCdpBridge", () => {
  it("maps linkedin-api requirement to linkedin platform id", () => {
    expect(platformIdsFromRequirements(["linkedin-api", "sqlite-utils"])).toEqual([
      "linkedin",
    ]);
  });

  it("supports platform: prefix requirements", () => {
    expect(platformIdsFromRequirements(["platform:site-notion-so"])).toEqual([
      "site-notion-so",
    ]);
  });

  it("detects jobs that need platform CDP", () => {
    expect(jobNeedsPlatformCdp({ requirements: ["requests"] })).toBe(false);
    expect(jobNeedsPlatformCdp({ requirements: ["linkedin-api"] })).toBe(true);
  });

  it("resolves CDP URL with legacy env override", () => {
    const prev = process.env.LINKEDIN_CHROME_CDP_URL;
    process.env.LINKEDIN_CHROME_CDP_URL = "http://127.0.0.1:9333";
    try {
      expect(resolvePlatformCdpUrl()).toBe("http://127.0.0.1:9333");
    } finally {
      if (prev === undefined) {
        delete process.env.LINKEDIN_CHROME_CDP_URL;
      } else {
        process.env.LINKEDIN_CHROME_CDP_URL = prev;
      }
    }
  });
});
