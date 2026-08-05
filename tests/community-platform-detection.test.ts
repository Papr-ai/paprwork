import { describe, expect, test } from "vitest";
import {
  contentUsesDesktopOnlyPaprApi,
  extractPaprApiInvokeMethods,
  getDesktopOnlyPaprApiMethods,
} from "../src/gateway/utils/paprApiCloudSafety.js";
import { deriveCommunityPlatform } from "../src/gateway/utils/communityPlatformDetection.js";
import { scanMiniAppCloudCompatibility } from "../src/gateway/utils/miniAppCloudCompatibility.js";

describe("paprApiCloudSafety", () => {
  test("treats chat.open as cloud-safe", () => {
    const content = `
      window.paprAPI.invoke('chat.open', { message: 'Help me' });
    `;
    expect(extractPaprApiInvokeMethods(content)).toEqual(["chat.open"]);
    expect(getDesktopOnlyPaprApiMethods(content)).toEqual([]);
    expect(contentUsesDesktopOnlyPaprApi(content)).toBe(false);
  });

  test("flags shell and notification IPC as desktop-only", () => {
    const content = `
      paprAPI.invoke('shell.openExternal', url);
      paprAPI.invoke('notification.show', { title: 'Done' });
    `;
    expect(getDesktopOnlyPaprApiMethods(content).sort()).toEqual([
      "notification.show",
      "shell.openExternal",
    ]);
  });
});

describe("communityPlatformDetection", () => {
  test("cloud-ready app with chat.open stays all-platforms", () => {
    const fileContents = new Map([
      [
        "app.ts",
        `fetch('/api/db/query'); window.paprAPI.invoke('chat.open', {});`,
      ],
    ]);
    const report = deriveCommunityPlatform({
      fileContents,
      jobs: [],
      compatibilityFindings: scanMiniAppCloudCompatibility(fileContents),
    });
    expect(report.requiresDesktopForFullFunctionality).toBe(false);
    expect(report.platform).toEqual(["macos", "windows", "linux"]);
  });

  test("desktop paprAPI restricts to OS signals when present", () => {
    const fileContents = new Map([
      [
        "recorder.swift",
        "import ScreenCaptureKit",
      ],
      [
        "app.ts",
        `paprAPI.invoke('notification.show', { title: 'Recording' });`,
      ],
    ]);
    const findings = scanMiniAppCloudCompatibility(fileContents);
    const report = deriveCommunityPlatform({
      fileContents,
      jobs: [{ type: "swift", command: "swift run recorder" }],
      compatibilityFindings: findings,
    });
    expect(report.requiresDesktopForFullFunctionality).toBe(true);
    expect(report.platform).toEqual(["macos"]);
    expect(findings.some((f) => f.category === "papr-api")).toBe(true);
  });

  test("vault keys in jobs do not require desktop when UI is cloud-only", () => {
    const fileContents = new Map([["app.ts", `fetch('/api/db/query');`]]);
    const report = deriveCommunityPlatform({
      fileContents,
      jobs: [{ type: "python", command: "python scrape.py --key '${GROQ_API_KEY}'" }],
      compatibilityFindings: scanMiniAppCloudCompatibility(fileContents),
    });
    expect(report.requiresDesktopForFullFunctionality).toBe(false);
    expect(report.platform).toEqual(["macos", "windows", "linux"]);
  });

  test("job triggers and agent jobs do not require desktop", () => {
    const fileContents = new Map([
      ["app.ts", `fetch('/api/jobs/run', { method: 'POST', body: JSON.stringify({ jobId }) });`],
    ]);
    const findings = scanMiniAppCloudCompatibility(fileContents);
    const report = deriveCommunityPlatform({
      fileContents,
      jobs: [{ type: "agent", command: "Review inbox" }],
      compatibilityFindings: findings,
    });
    expect(report.requiresDesktopForFullFunctionality).toBe(false);
    expect(findings.some((f) => f.category === "job-trigger")).toBe(true);
  });

  test("local CDP chrome-manager requires desktop", () => {
    const fileContents = new Map([
      ["app.ts", `puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });`],
    ]);
    const report = deriveCommunityPlatform({
      fileContents,
      jobs: [],
      compatibilityFindings: scanMiniAppCloudCompatibility(fileContents),
    });
    expect(report.requiresDesktopForFullFunctionality).toBe(true);
  });
});
