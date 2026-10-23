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

  it("treats App Files as cloud-compatible, not desktop-only", () => {
    // An app referencing a large asset used to have no signal here at all. The
    // cloud host now serves /api/files/url, so file usage must not push an app
    // toward desktop-only — and the author should be told it will work.
    const files = new Map<string, string>([
      [
        "video.js",
        `const r = await fetch('/api/files/url', {
  method: 'POST',
  body: JSON.stringify({ id }),
});`,
      ],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("cloud-ready");
    expect(report.cloudWorks.join(" ")).toContain("App Files");
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

  it("flags desktop paprAPI methods as desktop-only", () => {
    const files = new Map<string, string>([
      ["app.js", `window.paprAPI.invoke('shell.openExternal', 'https://x');`],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("desktop-only");
  });

  it("treats paprAPI chat.open as cloud-safe", () => {
    const files = new Map<string, string>([
      ["app.js", `window.paprAPI.invoke('chat.open', {});`],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("cloud-ready");
  });

  it("job triggers run in the cloud sandbox (cloud-ready)", () => {
    const files = new Map<string, string>([
      [
        "actions.js",
        `await fetch('/api/jobs/run', { method: 'POST', body: JSON.stringify({ jobId }) });`,
      ],
      ["db.js", `fetch('/api/db/query', { method: 'POST' });`],
    ]);
    const report = buildCloudCompatibilityReport(scanMiniAppCloudCompatibility(files));
    expect(report.level).toBe("cloud-ready");
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

describe("data-sources dbPath", () => {
  it("a synced registry or job database is cloud-ready; a path-only source is not", async () => {
    const { scanMiniAppCloudCompatibility } = await import("../src/gateway/utils/miniAppCloudCompatibility.js");
    const synced = JSON.stringify({ sources: [{ dbId: "db-1", alias: "sync", dbPath: "/Users/me/Papr/data/databases/x/data.db" }] });
    expect(scanMiniAppCloudCompatibility(new Map(), synced)).toEqual([]);
    const local = JSON.stringify({ sources: [{ alias: "notes", dbPath: "/Users/me/notes.db" }] });
    expect(scanMiniAppCloudCompatibility(new Map(), local).map((f) => f.category)).toEqual(["absolute-path"]);
  });
});

import { desktopJobFinding, mergeCloudCompatibilityFindings } from "../src/gateway/utils/miniAppCloudCompatibility.js";

describe("desktop-only jobs in the publish report", () => {
  it("makes the app hybrid and names the job and reason", () => {
    const report = mergeCloudCompatibilityFindings([
      [],
      [desktopJobFinding("j1", "LinkedIn Sender", "Uses your Chrome", { file: "code/send.py", line: 51 })],
    ]);
    expect(report.level).toBe("hybrid");
    expect(report.requiresAcknowledgement).toBe(false);
    expect(report.desktopOnly).toContain("LinkedIn Sender only runs in Papr Work desktop — uses your Chrome.");
    expect(report.summary).toContain("1 job only runs in Papr Work desktop");
    expect(report.desktopOnly.join(" ")).not.toContain("/api/bash/run");
  });
});
