import { describe, expect, it } from "vitest";
import {
  buildCloudCompatibilityReport,
  scanMiniAppCloudCompatibility,
  scanJobCloudCompatibility,
} from "../src/gateway/utils/miniAppCloudCompatibility.js";

describe("scanMiniAppCloudCompatibility", () => {
  it("marks cloud-ready apps with db queries only", () => {
    const files = new Map<string, string>([
      [
        "db.js",
        `async function q() {
  return fetch('/api/db/query', { method: 'POST', body: '{}' });
}`,
      ],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("cloud-ready");
    expect(report.requiresAcknowledgement).toBe(false);
  });

  it("flags localhost gateway as desktop-only", () => {
    const files = new Map<string, string>([
      [
        "jobs-api.js",
        `fetch('http://localhost:18789/api/jobs/run', { method: 'POST' });`,
      ],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("desktop-only");
    expect(report.requiresAcknowledgement).toBe(true);
    expect(report.findings.some((f) => f.category === "localhost-gateway")).toBe(true);
  });

  it("flags paprAPI as desktop-only", () => {
    const files = new Map<string, string>([
      ["app.js", `window.paprAPI.invoke('chat.open', {});`],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("desktop-only");
  });

  it("marks relative job triggers as hybrid", () => {
    const files = new Map<string, string>([
      [
        "actions.js",
        `await fetch('/api/jobs/run', { method: 'POST', body: JSON.stringify({ jobId }) });`,
      ],
      ["db.js", `fetch('/api/db/query', { method: 'POST' });`],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("hybrid");
    expect(report.requiresAcknowledgement).toBe(false);
  });
});

describe("scanJobCloudCompatibility", () => {
  it("flags chrome manager jobs as desktop-only", () => {
    const findings = scanJobCloudCompatibility(
      "job-1",
      "Chrome Manager",
      "node chrome-manager.js",
      new Map([
        ["chrome-manager.js", "await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });"],
      ]),
    );
    const report = buildCloudCompatibilityReport(findings);
    expect(report.level).toBe("desktop-only");
    expect(report.findings.some((f) => f.category === "chrome-automation")).toBe(true);
  });
});
