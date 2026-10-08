import { describe, expect, it, vi } from "vitest";
import {
  classifyItems,
  goalsKey,
  itemsNeedingWork,
  pickFromAnswer,
  resolveTaskGoal,
  type AttributionGoal,
  type JevFn,
} from "../src/gateway/services/focusAttribution.js";
import { splitDivergedPicks, identityScope } from "../src/gateway/services/focusGoals.js";
import { scoreFocusCandidates, type FocusCandidateInput } from "../src/gateway/services/focusGoalsScoring.js";
import { builderPrompt, connectedSources, findTemplate, resolveTrackerState } from "../src/gateway/services/focusTrackers.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const GOALS: AttributionGoal[] = [
  { id: "G4", title: "Validate MHAR depth-router + file patent claims" },
  { id: "G6", title: "Ship Stage-A pretraining for papr-embed-v2" },
  { id: "pick:F-1", title: "Distribution via content creation, build following", scope: "posts on X and LinkedIn, launch videos, integrations like a Claude plugin / MCP UI", custom: true },
];

describe("goal identity", () => {
  it("a pick rewritten into a different goal gets its own id and drops the old goal", () => {
    const goals = new Map([["G4", { title: "Validate MHAR depth-router + file patent claims" }], ["G1", { title: "Close pre-seed Tranche 1" }]]);
    const { picks, changed } = splitDivergedPicks(
      [
        { id: "G4", goalId: "G4", title: "Distribution via content creation, build following", target: "1 post daily" },
        { id: "G1", goalId: "G1", title: "Close pre-seed Tranche 1 by Oct" },
      ],
      goals,
      NOW,
    );
    expect(changed).toBe(true);
    expect(picks[0].goalId).toBeUndefined();
    expect(picks[0].id).toMatch(/^F-/);
    expect(picks[0].target).toBe("1 post daily");
    expect(picks[1]).toEqual({ id: "G1", goalId: "G1", title: "Close pre-seed Tranche 1 by Oct" }); // same goal, renamed
  });

  it("identity scope comes from the goal's own milestone and entities", () => {
    expect(identityScope({ nextMilestone: "File claims", entities: ["app/mhar-depth-router"] })).toBe("File claims; mhar depth router");
  });
});

describe("Jev attribution", () => {
  const ids = new Set(GOALS.map((g) => g.id));
  it("abstains below threshold and on NONE", () => {
    expect(pickFromAnswer({ choice: "pick:F-1", confidence: 1, probabilities: { "pick:F-1": 1 } }, ids).goal).toBe("pick:F-1");
    expect(pickFromAnswer({ choice: "pick:F-1", confidence: 0.56, probabilities: { "pick:F-1": 0.56, NONE: 0.44 } }, ids).goal).toBeNull();
    expect(pickFromAnswer({ choice: "NONE", confidence: 0.99 }, ids).goal).toBeNull();
    expect(pickFromAnswer({ choice: "G99", confidence: 0.99 }, ids).goal).toBeNull();
  });

  it("batches 20 questions per Jev call and uses goal scope in the criteria", async () => {
    const jev = vi.fn<JevFn>(async (_state, questions) =>
      Object.fromEntries(Object.keys(questions).map((k) => [k, { choice: "pick:F-1", confidence: 0.9 }])),
    );
    const items = Array.from({ length: 25 }, (_, i) => ({ key: `chat:${i}`, text: `item ${i}` }));
    const out = await classifyItems(GOALS, items, jev);
    expect(jev).toHaveBeenCalledTimes(2);
    expect(Object.keys(jev.mock.calls[0][1])).toHaveLength(20);
    expect(jev.mock.calls[0][1].item_1.criteria["pick:F-1"]).toContain("Claude plugin");
    expect(out["chat:24"].goal).toBe("pick:F-1");
  });

  it("only re-asks new or edited items, and everything when goals change", () => {
    const key = goalsKey(GOALS);
    const file = { version: 1 as const, goalsKey: key, updatedAt: "", items: {} as Record<string, { goal: string | null; p: number; hash: string }> };
    const items = [{ key: "chat:a", text: "a" }, { key: "chat:b", text: "b" }];
    expect(itemsNeedingWork(file, key, items)).toHaveLength(2);
    expect(itemsNeedingWork(null, key, items)).toHaveLength(2);
    expect(goalsKey(GOALS)).not.toBe(goalsKey([...GOALS.slice(0, 2), { ...GOALS[2], scope: "different" }]));
  });

  it("Sleep tags win unless Jev confidently picks a goal the user wrote", () => {
    const map = new Map(GOALS.map((g) => [g.id, g]));
    const tagged = { goal_id: "G4", goal_source: "tag" };
    expect(resolveTaskGoal(tagged, { goal: "G6", p: 0.99, hash: "" }, map)).toBe("G4");
    expect(resolveTaskGoal(tagged, { goal: "pick:F-1", p: 0.7, hash: "" }, map)).toBe("G4");
    expect(resolveTaskGoal(tagged, { goal: "pick:F-1", p: 0.95, hash: "" }, map)).toBe("pick:F-1");
    expect(resolveTaskGoal({ goal_id: null }, { goal: "pick:F-1", p: 0.75, hash: "" }, map)).toBe("pick:F-1");
    expect(resolveTaskGoal({ goal_id: "G4", goal_source: "entity" }, undefined, map)).toBe("G4");
  });

  it("Jev's chat assignment beats keywords: the MCP UI chat counts toward Distribution", () => {
    const goals: FocusCandidateInput[] = [
      { id: "G4", title: "Validate MHAR depth-router + file patent claims", origin: "identity", status: "proposed" },
      { id: "pick:F-1", title: "Distribution via content creation, build following", origin: "custom" },
    ];
    const chats = [
      { id: "c1", text: "Claude recently launched plugins \n MCP UI, Prototyper", updatedAt: "2026-10-07", hours7: 3.4, hours30: 3.4 },
      { id: "c2", text: "Message queue CSS fix", updatedAt: "2026-10-07", hours7: 1, hours30: 1 },
    ];
    const base = { goals, onboarding: [], chats, logs: [], tasks: [], apps: [], now: NOW };
    const lexical = scoreFocusCandidates(base).ranked.find((g) => g.id === "pick:F-1")!;
    expect(lexical.signals.hours7).toBe(0); // the bug: zero shared words
    const jev = scoreFocusCandidates({ ...base, chatGoals: new Map([["c1", "pick:F-1"], ["c2", null]]) });
    expect(jev.ranked.find((g) => g.id === "pick:F-1")!.signals.hours7).toBe(3.4);
    expect(jev.hoursFor(["G4"])).toBe(0);
  });
});

describe("goal trackers", () => {
  const social = findTemplate("social-presence")!;
  it("recognizes legacy X keys as a connected source", () => {
    const conn = connectedSources(social, (k) => ["X_AUTH_TOKEN", "X_CT0", "LINKEDIN_LI_AT"].includes(k));
    expect(conn.get("x")).toEqual(["X_AUTH_TOKEN", "X_CT0"]);
    expect(conn.get("linkedin")).toEqual(["LINKEDIN_LI_AT"]);
  });

  it("status: ready → active with numbers; needs_connect; buildable without a script", () => {
    expect(resolveTrackerState({ template: social, jobExists: false, has: (k) => k === "LINKEDIN_LI_AT" })).toMatchObject({
      status: "ready", connected: ["LinkedIn"], missing: ["X"],
    });
    expect(resolveTrackerState({ template: social, jobExists: false, has: () => false }).status).toBe("needs_connect");
    expect(resolveTrackerState({ template: findTemplate("revenue"), jobExists: false, has: () => true }).status).toBe("buildable");
    expect(resolveTrackerState({ template: undefined, jobExists: false, has: () => true }).status).toBe("buildable");
    const active = resolveTrackerState({
      template: social, link: { jobId: "j1" }, jobExists: true, has: () => true,
      metrics: { goalId: "F-1", template: "social-presence", updatedAt: "2026-10-08", summary: { posts7: 7 } },
    });
    expect(active).toMatchObject({ status: "active", jobId: "j1" });
    expect(active.metrics?.labels.posts7).toBe("Posts this week");
  });

  it("the builder agent reuses connected sources and reports to the metrics endpoint", () => {
    const p = builderPrompt({ id: "F-1", title: "Grow revenue" }, findTemplate("revenue"), "http://127.0.0.1:18789");
    expect(p).toContain("/api/workspace/focus/metrics");
    expect(p).toContain("/api/workspace/focus/tracker/link");
    expect(p).toMatch(/Never ask for a key the user already has/);
  });

  it("the goal page gets its payoff number, history and evidence (chart + tiles need them)", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ date: `2026-09-${String(i).padStart(2, "0")}`, impressions7: i }));
    const items = Array.from({ length: 35 }, (_, i) => ({ source: "x", at: "2026-10-08T03:00:00Z", impressions: i }));
    const active = resolveTrackerState({
      template: social, link: { jobId: "j1" }, jobExists: true, has: () => true,
      metrics: { goalId: "F-1", template: "social-presence", updatedAt: "2026-10-08", summary: { impressions7: 9 }, history, items,
        sources: { x: { ok: true, profile: { handle: "me", avatar: "https://pbs.twimg.com/a.jpg" } } } },
    });
    expect(active.metrics?.hero).toBe("impressions7");
    expect(active.metrics?.history).toHaveLength(30);
    expect(active.metrics?.history?.at(-1)?.impressions7).toBe(39);
    expect(active.metrics?.items).toHaveLength(30);
    expect(active.metrics?.sources?.x.profile?.avatar).toMatch(/^https:/);
    // A custom tracker's first summary key is its headline.
    const custom = resolveTrackerState({ template: undefined, link: { jobId: "j2" }, jobExists: true, has: () => true,
      metrics: { goalId: "F-2", template: "custom", updatedAt: "2026-10-08", summary: { signed: 3, calls: 9 } } });
    expect(custom.metrics?.hero).toBe("signed");
  });

  it("custom trackers are asked for the visual goal-page shape: items with time, faces, logos", () => {
    const p = builderPrompt({ id: "F-1", title: "Land 5 design partners" }, undefined, "http://127.0.0.1:18789");
    expect(p).toContain("preloaded-goal-page-design");
    expect(p).toMatch(/"at" \(ISO time/);
    expect(p).toMatch(/"domain"/);
    expect(p).toMatch(/profile/);
    expect(p).toMatch(/Never generate or guess images/);
  });
});
