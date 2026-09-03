import { describe, expect, it } from "vitest";
import {
  isAuthenticatedPlatformUrl,
  isLoggedOutPlatformUrl,
} from "../src/gateway/services/platforms/platformSessionUrl.js";
import type { PlatformConfig } from "../src/gateway/services/platforms/platformRegistry.js";

describe("platformSessionUrl", () => {
  it("detects common login URLs", () => {
    expect(isLoggedOutPlatformUrl("https://app.example.com/login")).toBe(true);
    expect(isLoggedOutPlatformUrl("https://app.example.com/dashboard")).toBe(false);
  });

  it("treats custom sites as authenticated when on host and not login page", () => {
    const config = {
      isCustom: true,
      originHost: "notion.so",
      successUrlPattern: /notion\.so/i,
    } as PlatformConfig;

    expect(
      isAuthenticatedPlatformUrl("https://www.notion.so/my-page", config),
    ).toBe(true);
    expect(
      isAuthenticatedPlatformUrl("https://www.notion.so/login", config),
    ).toBe(false);
  });

  it("matches navigation URLs ignoring trailing slashes", async () => {
    const { platformNavigationUrlsMatch } = await import(
      "../src/gateway/services/platforms/platformSessionUrl.js"
    );
    expect(
      platformNavigationUrlsMatch(
        "https://www.linkedin.com/in/mehrisamalik/",
        "https://www.linkedin.com/in/mehrisamalik",
      ),
    ).toBe(true);
  });

  it("skips landing hop when already on authenticated LinkedIn profile", async () => {
    const { shouldSkipPlatformLandingHop } = await import(
      "../src/gateway/services/platforms/platformSessionUrl.js"
    );
    const config = {
      id: "linkedin",
      successUrlPattern: /linkedin\.com\/(feed|in\/|mynetwork|messaging)/i,
    } as PlatformConfig;

    expect(
      shouldSkipPlatformLandingHop(
        "https://www.linkedin.com/in/mehrisamalik/",
        "https://www.linkedin.com/in/other-person/",
        config,
      ),
    ).toBe(true);
    expect(
      shouldSkipPlatformLandingHop(
        "https://www.linkedin.com/uas/login",
        "https://www.linkedin.com/in/mehrisamalik/",
        config,
      ),
    ).toBe(false);
  });
});
