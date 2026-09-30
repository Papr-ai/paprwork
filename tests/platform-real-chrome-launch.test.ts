import { describe, expect, it } from "vitest";
import {
  REAL_CHROME_IGNORE_DEFAULT_ARGS,
  REAL_CHROME_LAUNCH_ARGS,
  buildRealChromePersistentLaunchOptions,
} from "../src/gateway/services/platforms/platformRealChromeLaunch.js";

describe("platformRealChromeLaunch", () => {
  it("enables Chromium sandbox for real Google Chrome (no --no-sandbox banner)", () => {
    const options = buildRealChromePersistentLaunchOptions();
    expect(options.chromiumSandbox).toBe(true);
  });

  it("strips Playwright enable-automation flag", () => {
    const options = buildRealChromePersistentLaunchOptions();
    expect(options.ignoreDefaultArgs).toEqual([...REAL_CHROME_IGNORE_DEFAULT_ARGS]);
    expect(options.channel).toBe("chrome");
  });

  it("includes CDP port for Playwright fallback connect flow", () => {
    const options = buildRealChromePersistentLaunchOptions({ includeCdpPort: true });
    expect(options.args).toEqual([...REAL_CHROME_LAUNCH_ARGS]);
    expect(options.args.some((arg) => arg.includes("AutomationControlled"))).toBe(false);
  });

  it("omits CDP port for Playwright fallback connect flow", () => {
    const options = buildRealChromePersistentLaunchOptions({
      includeCdpPort: false,
      channel: "chrome",
    });
    expect(options.args.some((arg) => arg.includes("remote-debugging-port"))).toBe(false);
  });
});
