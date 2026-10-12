import { describe, expect, it } from "vitest";
import { aggregateOverview, bashIntent } from "../src/gateway/services/agentsOverview/aggregateOverview.js";
import type { OverviewRow } from "../src/gateway/services/agentsOverview/overviewRows.js";
import { billingFor, inferTurnTargets } from "../src/gateway/services/storage/turnAttribution.js";

const APP = "7daffcac-4144-46a7-98b7-0ac1c838f670";

function row(partial: Partial<OverviewRow>): OverviewRow {
  return {
    id: Math.random().toString(36).slice(2),
    chat_id: "c1",
    timestamp: "2026-10-10T12:00:00.000Z",
    model: "claude-opus-5-5",
    agent_id: "main-agent",
    cost: 1,
    fresh: 10,
    cache_read: 80,
    cache_write: 5,
    output: 5,
    peak: 1000,
    steps: 4,
    billing: null,
    app_id: null,
    repo: null,
    tools: null,
    targets: null,
    bash: null,
    ...partial,
  };
}

const base = {
  chats: [{ id: "c1", title: "Pricing", summary_short: null }],
  days: 30,
  now: new Date("2026-10-11T12:00:00.000Z"),
  appTitles: new Map([[APP, "Agents Page Redesign Prototype"]]),
  workTypes: new Map<string, string>(),
};

describe("turn attribution", () => {
  it("maps credentials to who paid", () => {
    expect(billingFor({ authType: "oauth" })).toBe("subscription");
    expect(billingFor({ authType: "apiKey" })).toBe("api_key");
    expect(billingFor({ authType: "oauth", usePaprProxy: true })).toBe("papr");
  });

  it("finds the app and repo a turn touched", () => {
    const out = inferTurnTargets([
      `/Users/a/Papr/orgs/x/apps/${APP}/data.ts`,
      "cd /Users/a/Documents/GitHub/paprwork-v2 && rg foo src",
      "/Users/a/Documents/GitHub/paprwork-v2/ui/App.tsx",
    ]);
    expect(out).toEqual({ appId: APP, repo: "paprwork-v2" });
  });

  it("does not read src/ or /dev/null as repos", () => {
    expect(inferTurnTargets(["cat /dev/null; ls ./src/gateway"]).repo).toBeNull();
  });
});

describe("bash intents", () => {
  it("classifies the common commands", () => {
    expect(bashIntent("rg -n foo src")).toBe("Search");
    expect(bashIntent("cd x && sed -n 1,20p a.ts")).toBe("Read files");
    expect(bashIntent("python3 - <<EOF")).toBe("Scripts");
    expect(bashIntent("sqlite3 x.db 'select 1'")).toBe("sqlite");
  });
});

describe("aggregateOverview", () => {
  it("sums tokens the way the context meter does", () => {
    const o = aggregateOverview({ ...base, rows: [row({}), row({ cost: 2 })] });
    expect(o.totals.turns).toBe(2);
    expect(o.totals.cost).toBe(3);
    expect(o.totals.tokens).toBe(200);
    expect(o.chats[0]).toMatchObject({ title: "Pricing", turns: 2, tokens: 200 });
  });

  it("splits cost by who paid, keeping unrecorded turns separate", () => {
    const o = aggregateOverview({
      ...base,
      rows: [row({ billing: "api_key", cost: 3 }), row({ billing: "subscription", cost: 5 }), row({ cost: 1 })],
    });
    expect(o.billing).toEqual({ apiKey: 3, subscription: 5, papr: 0, unknown: 1 });
  });

  it("attributes app work and carries it into follow-up discussion", () => {
    const o = aggregateOverview({
      ...base,
      rows: [
        row({ tools: "create_app", targets: `/apps/${APP}/index.html`, cost: 2 }),
        row({ tools: "edit_file", targets: `/apps/${APP}/app.ts`, cost: 3 }),
        row({ cost: 4 }),
      ],
    });
    const app = o.projects.apps[0];
    expect(app.name).toBe("Agents Page Redesign Prototype");
    expect(app.split).toEqual([2, 3, 0, 4]);
    expect(o.projects.where.app).toBe(9);
  });

  it("prefers recorded columns over inference", () => {
    const o = aggregateOverview({
      ...base,
      rows: [row({ repo: "memory", targets: "/Users/a/Documents/GitHub/paprwork-v2/x.ts" })],
    });
    expect(o.projects.repos.map((r) => r.name)).toEqual(["memory"]);
    expect(o.projects.recordedShare).toBe(1);
  });

  it("ignores ids that are not installed apps", () => {
    const o = aggregateOverview({
      ...base,
      rows: [row({ targets: "/apps/00000000-1111-2222-3333-444444444444/a.ts" })],
    });
    expect(o.projects.apps).toEqual([]);
  });
});
