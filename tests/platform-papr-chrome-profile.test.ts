import { describe, expect, it } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  findPlatformIdForUrl,
  getSharedPaprChromeUserDataDir,
  hostnameMatchesPlatform,
} from "../src/gateway/services/platforms/platformPaprChromeProfile.js";
import { PLATFORM_REGISTRY } from "../src/gateway/services/platforms/platformRegistry.js";

describe("platformPaprChromeProfile", () => {
  useIsolatedPaprWorkspace();

  it("uses one shared Papr Chrome profile directory", () => {
    expect(getSharedPaprChromeUserDataDir()).toMatch(/browser-profiles\/_papr-chrome$/);
  });

  it("matches hostnames to platform cookie domains", () => {
    const linkedin = PLATFORM_REGISTRY.linkedin;
    expect(hostnameMatchesPlatform("www.linkedin.com", linkedin)).toBe(true);
    expect(hostnameMatchesPlatform("linkedin.com", linkedin)).toBe(true);
    expect(hostnameMatchesPlatform("www.reddit.com", linkedin)).toBe(false);
  });

  it("finds platform id from open tab URLs", () => {
    expect(findPlatformIdForUrl("https://www.linkedin.com/feed/")).toBe("linkedin");
    expect(findPlatformIdForUrl("https://x.com/home")).toBe("twitter");
    expect(findPlatformIdForUrl("https://www.reddit.com/")).toBe("reddit");
    expect(findPlatformIdForUrl("about:blank")).toBeNull();
  });
});
