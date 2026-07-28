import { describe, expect, test } from "vitest";
import { checkMiniAppJobEventPatterns } from "../src/gateway/utils/miniAppJobEventLint.js";

describe("checkMiniAppJobEventPatterns", () => {
  test("errors on setInterval + db query without job events SDK", () => {
    const files = new Map<string, string>([
      [
        "sources.ts",
        `
setInterval(async () => {
  await fetch('/api/db/query', { method: 'POST', body: '{}' });
}, 2000);
`,
      ],
    ]);
    const issues = checkMiniAppJobEventPatterns(files);
    expect(issues.some((i) => i.rule === "no-db-polling" && i.severity === "error")).toBe(
      true,
    );
  });

  test("errors on for-loop + await setTimeout + backend action polling", () => {
    const files = new Map<string, string>([
      [
        "app.js",
        `
const JOB_ID = 'abc';
async function generatePicks() {
  await fetch('/api/jobs/run', { method: 'POST', body: JSON.stringify({ jobId: JOB_ID }) });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await fetch('/api/app/backend/topics', { method: 'POST', body: '{}' });
  }
}
`,
      ],
    ]);
    const issues = checkMiniAppJobEventPatterns(files);
    expect(issues.some((i) => i.rule === "no-db-polling" && i.severity === "error")).toBe(
      true,
    );
    expect(issues.some((i) => i.rule === "prefer-job-events" && i.severity === "error")).toBe(
      true,
    );
  });

  test("passes when subscribeJobEvents is used", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `
import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';
setInterval(() => {}, 2000);
await fetch('/api/db/query', { method: 'POST' });
subscribeJobEvents({ jobIds: ['x'], onDbChanged: () => loadData() });
`,
      ],
    ]);
    const issues = checkMiniAppJobEventPatterns(files);
    expect(issues.filter((i) => i.rule === "no-db-polling")).toHaveLength(0);
  });

  test("errors on local papr-job-events shim import", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `
import { subscribeJobEvents } from './papr-job-events.ts';
subscribeJobEvents({ jobIds: ['x'], onDbChanged: () => loadData() });
`,
      ],
    ]);
    const issues = checkMiniAppJobEventPatterns(files);
    expect(
      issues.some((i) => i.rule === "no-job-events-shim" && i.severity === "error"),
    ).toBe(true);
  });

  test("passes when job run uses subscribeJobEvents with onDbChanged", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `
import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';
const JOB_ID = 'abc';
subscribeJobEvents({ jobIds: [JOB_ID], onDbChanged: () => loadData() });
async function trigger() {
  await fetch('/api/jobs/run', { method: 'POST', body: JSON.stringify({ jobId: JOB_ID }) });
}
`,
      ],
    ]);
    const issues = checkMiniAppJobEventPatterns(files);
    expect(issues).toHaveLength(0);
  });

  test("errors on declare-only subscribeJobEvents without SDK import", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `
declare function subscribeJobEvents(cfg: { onDbChanged?: () => void }): () => void;
async function init() {
  subscribeJobEvents({ onDbChanged: () => refresh() });
  await fetch('/api/jobs/run', { method: 'POST', body: '{}' });
}
`,
      ],
    ]);
    const issues = checkMiniAppJobEventPatterns(files);
    expect(
      issues.some(
        (i) => i.rule === "missing-job-events-import" && i.severity === "error",
      ),
    ).toBe(true);
  });

  test("errors when subscribeJobEvents called without any import", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `
async function init() {
  subscribeJobEvents({ onStatusChanged: () => {} });
}
`,
      ],
    ]);
    const issues = checkMiniAppJobEventPatterns(files);
    expect(
      issues.some(
        (i) => i.rule === "missing-job-events-import" && i.severity === "error",
      ),
    ).toBe(true);
  });
});
