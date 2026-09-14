import { describe, expect, it } from "vitest";
import { checkMiniAppLoadEfficiencyPatterns } from "../src/gateway/utils/miniAppLoadEfficiencyLint.js";
import { analyzePreviewNetworkLogs } from "../src/gateway/utils/miniAppPreviewNetworkProfile.js";

function files(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("checkMiniAppLoadEfficiencyPatterns", () => {
  it("flags 3+ db queries in loadData without batch", () => {
    const issues = checkMiniAppLoadEfficiencyPatterns(
      files({
        "app.ts": `
          async function loadData() {
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
          }
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "mount-multi-db-query")).toBe(true);
  });

  it("still flags loadData when batch is only in another function", () => {
    const issues = checkMiniAppLoadEfficiencyPatterns(
      files({
        "app.ts": `
          async function loadData() {
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
          }
          async function loadAll() {
            await fetch('/api/db/batch', { method: 'POST', body: '{}' });
          }
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "mount-multi-db-query")).toBe(true);
  });

  it("allows loadData when batch is used inside the same function", () => {
    const issues = checkMiniAppLoadEfficiencyPatterns(
      files({
        "app.ts": `
          async function loadData() {
            await fetch('/api/db/batch', { method: 'POST', body: '{}' });
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
          }
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "mount-multi-db-query")).toBe(false);
  });

  it("flags db query inside map (N+1)", () => {
    const issues = checkMiniAppLoadEfficiencyPatterns(
      files({
        "app.ts": `
          async function loadRows(ids) {
            return Promise.all(ids.map(async (id) => {
              const r = await fetch('/api/db/query', { method: 'POST', body: '{}' });
              return r.json();
            }));
          }
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "db-query-in-loop")).toBe(true);
  });

  it("flags sync items polling without refresh=1", () => {
    const issues = checkMiniAppLoadEfficiencyPatterns(
      files({
        "app.ts": `
          setInterval(() => {
            void fetch('/api/sync/items?appId=x');
          }, 5000);
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "sync-items-poll-no-refresh")).toBe(
      true,
    );
  });

  it("warns onDbChanged -> loadData without debounceMs", () => {
    const issues = checkMiniAppLoadEfficiencyPatterns(
      files({
        "app.ts": `
          subscribeJobEvents({
            jobIds: ['j1'],
            onDbChanged: () => loadData(),
          });
          async function loadData() {
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
          }
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "on-db-changed-no-debounce")).toBe(
      true,
    );
  });

  it("skips onDbChanged debounce warning when debounceMs is set", () => {
    const issues = checkMiniAppLoadEfficiencyPatterns(
      files({
        "app.ts": `
          subscribeJobEvents({
            jobIds: ['j1'],
            debounceMs: 300,
            onDbChanged: () => loadData(),
          });
          async function loadData() {
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
            await fetch('/api/db/query', { method: 'POST', body: '{}' });
          }
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "on-db-changed-no-debounce")).toBe(
      false,
    );
  });
});

describe("analyzePreviewNetworkLogs", () => {
  it("warns when many query requests and no batch", () => {
    const profile = analyzePreviewNetworkLogs([
      { url: "http://127.0.0.1:18789/api/db/query", method: "POST" },
      { url: "http://127.0.0.1:18789/api/db/query", method: "POST" },
      { url: "http://127.0.0.1:18789/api/db/query", method: "POST" },
      { url: "http://127.0.0.1:18789/api/db/query", method: "POST" },
    ]);
    expect(profile.dbQueryCount).toBe(4);
    expect(profile.warnings.length).toBeGreaterThan(0);
  });

  it("does not warn when batch reads are used", () => {
    const profile = analyzePreviewNetworkLogs([
      { url: "/api/db/batch", method: "POST" },
      { url: "/api/db/query", method: "POST" },
      { url: "/api/db/query", method: "POST" },
      { url: "/api/db/query", method: "POST" },
      { url: "/api/db/query", method: "POST" },
    ]);
    expect(profile.dbBatchCount).toBe(1);
    expect(
      profile.warnings.some((w) => w.includes("0 batch reads")),
    ).toBe(false);
  });
});
