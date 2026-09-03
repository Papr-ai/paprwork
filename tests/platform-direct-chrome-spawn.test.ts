import { describe, expect, it } from "vitest";
import {
  DIRECT_CHROME_BASE_ARGS,
  buildDirectChromeSpawnArgs,
  buildPlatformCdpUrl,
  isCdpAttachUnsupportedError,
  isChromeUsingUserDataDir,
  resolvePlatformCdpPort,
} from "../src/gateway/services/platforms/platformDirectChromeSpawn.js";

describe("platformDirectChromeSpawn", () => {
  it("builds minimal Chrome Manager-style args", () => {
    const args = buildDirectChromeSpawnArgs({
      userDataDir: "/tmp/papr-linkedin",
      cdpPort: 9222,
      startUrl: "https://www.linkedin.com/login",
    });
    expect(args).toContain("--user-data-dir=/tmp/papr-linkedin");
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toEqual(
      expect.arrayContaining([...DIRECT_CHROME_BASE_ARGS]),
    );
    expect(args).toContain("https://www.linkedin.com/login");
    expect(args.some((arg) => arg.includes("no-sandbox"))).toBe(false);
    expect(args.some((arg) => arg.includes("AutomationControlled"))).toBe(false);
    expect(args).toContain("--disable-extensions");
  });

  it("defaults CDP port to 9222", () => {
    expect(resolvePlatformCdpPort()).toBe(9222);
    expect(buildPlatformCdpUrl()).toBe("http://127.0.0.1:9222");
  });

  it("detects CDP attach unsupported errors", () => {
    expect(
      isCdpAttachUnsupportedError(
        new Error(
          "browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior): Browser context management is not supported.",
        ),
      ),
    ).toBe(true);
    expect(isCdpAttachUnsupportedError(new Error("timeout"))).toBe(false);
  });

  it("isChromeUsingUserDataDir returns false when port is free", () => {
    expect(isChromeUsingUserDataDir(59999, "/tmp/no-such-profile")).toBe(false);
  });
});
