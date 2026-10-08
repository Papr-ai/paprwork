import { describe, expect, it, vi } from "vitest";
import {
  jobNeedsPlatformCdp,
  platformCdpEnvForRun,
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

describe("platformCdpEnvForRun", () => {
  const embedded = () => Promise.reject(new Error("Port 9333 is Paprwork's own DevTools endpoint"));

  it("skips setup for jobs without platform requirements", async () => {
    const ensure = vi.fn();
    expect(await platformCdpEnvForRun({ requirements: ["playwright"] }, () => {}, ensure)).toEqual({});
    expect(ensure).not.toHaveBeenCalled();
  });

  it("fails the run by default when the browser cannot be prepared", async () => {
    await expect(platformCdpEnvForRun({ requirements: ["linkedin-api"] }, () => {}, embedded)).rejects.toThrow(
      "Platform browser CDP setup failed: Port 9333",
    );
  });

  it("best-effort jobs continue, log the reason and pass it to the script", async () => {
    const log = vi.fn();
    const env = await platformCdpEnvForRun({ requirements: ["linkedin-api"], platformCdp: "best-effort" }, log, embedded);
    expect(env).toEqual({ PAPR_PLATFORM_CDP_ERROR: "Port 9333 is Paprwork's own DevTools endpoint" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("best-effort, continuing"));
  });

  it("best-effort jobs still get the CDP env when setup works", async () => {
    const ok = async () => ({ PAPR_PLATFORM_CDP_URL: "http://127.0.0.1:9222" });
    expect(await platformCdpEnvForRun({ requirements: ["linkedin-api"], platformCdp: "best-effort" }, () => {}, ok)).toEqual({
      PAPR_PLATFORM_CDP_URL: "http://127.0.0.1:9222",
    });
  });
});
