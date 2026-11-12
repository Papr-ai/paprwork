import { describe, expect, it, vi } from "vitest";
import { buildPlan, rankAsks, type AskInput, type TriageJev } from "./askTriage";
import type { MentionItem } from "./mentions";

const ask = (id: string, text: string, extra: Partial<MentionItem> = {}): AskInput => ({
  item: { id, fromUserId: "u1", fromName: "Shawkat Kabbara", toUserId: "me", toName: "Amir", text, context: {}, action: null,
    status: "open", reply: null, createdAt: "2026-11-12T10:00:00Z", ...extra },
});
const goals = [{ id: "G1", title: "Ship Customer Contacts" }, { id: "G2", title: "TechStars pilot" }];
const plan = [{ key: "rank:1", title: "Re-ask Corey: migration SQL" }, { key: "rank:2", title: "AGM slides" }];
const fixed = (answers: Record<string, { choice: string; confidence: number }>): TriageJev & { calls: number; last?: string } => {
  const f = (async (state: string) => { f.calls++; f.last = state; return answers; }) as unknown as TriageJev & { calls: number; last?: string };
  f.calls = 0;
  return f;
};

describe("rankAsks (Jev decides, code applies)", () => {
  it("places a confident today ask before the item Jev picked, with its goal", async () => {
    const jev = fixed({ when_1: { choice: "today", confidence: 0.8 }, goal_1: { choice: "G1", confidence: 0.75 }, slot_1: { choice: "before_1", confidence: 0.7 } });
    const r = await rankAsks([{ ...ask("a", "Sign off #447 today?"), findings: "PR #447 is green; release waits on it", why: "Release blocked" }], goals, plan, jev, "2026-11-12");
    expect(r.a).toMatchObject({ when: "today", goalId: "G1", placed: true, before: "rank:1", planDate: "2026-11-12", why: "Release blocked" });
    expect(jev.last).toContain("Pen checked: PR #447 is green");
  });

  it("does not move the plan when Jev is unsure, or says this week", async () => {
    const unsure = fixed({ when_1: { choice: "now", confidence: 0.5 }, slot_1: { choice: "before_1", confidence: 0.9 }, goal_1: { choice: "G1", confidence: 0.4 } });
    const r1 = await rankAsks([ask("a", "x")], goals, plan, unsure);
    expect(r1.a.placed).toBe(false);
    expect(r1.a.goalId).toBeUndefined(); // a low-confidence goal is dropped, not guessed
    const later = fixed({ when_1: { choice: "this_week", confidence: 0.9 }, slot_1: { choice: "end", confidence: 0.9 } });
    expect((await rankAsks([ask("a", "x")], goals, plan, later)).a).toMatchObject({ when: "this_week", placed: false });
  });

  it("ranks a burst of asks in one call and skips answers Jev didn't give", async () => {
    const jev = fixed({ when_1: { choice: "fyi", confidence: 0.9 }, slot_1: { choice: "not_today", confidence: 0.9 } });
    const r = await rankAsks([ask("a", "fyi"), ask("b", "?")], goals, plan, jev);
    expect(jev.calls).toBe(1);
    expect(r.a.when).toBe("fyi");
    expect(r.b).toBeUndefined();
  });
});

describe("buildPlan (one plan)", () => {
  it("slots today's placed asks into the brief's priorities and ignores old days", () => {
    const p = buildPlan([{ rank: 1, title: "A" }, { rank: 2, title: "B" }], [
      { id: "x", title: "Shawkat: sign off", triage: { before: "rank:2", planDate: "2026-11-12" } },
      { id: "y", title: "Old", triage: { before: "rank:1", planDate: "2026-11-11" } },
      { id: "z", title: "End", triage: { before: "end", planDate: "2026-11-12" } },
    ], "2026-11-12");
    expect(p.map((e) => e.key)).toEqual(["rank:1", "ask:x", "rank:2", "ask:z"]);
  });
  it("doesn't add an ask the brief already ranked", () => {
    const p = buildPlan([{ rank: 1, title: "Reply to Shawkat", mention_id: "x" }], [{ id: "x", title: "dup", triage: { before: "end", planDate: "d" } }], "d");
    expect(p).toHaveLength(1);
  });
});

describe("rankMissing", () => {
  it("queues only asks with no ranking, once each", async () => {
    vi.useFakeTimers();
    const { rankMissing, _queuedIds } = await import("./askTriage");
    const a = ask("x1", "old ask").item, b = { ...ask("x2", "ranked").item, triage: { when: "fyi" } } as never;
    rankMissing([a, b]); rankMissing([a]);
    expect(_queuedIds()).toEqual(["x1"]);
    vi.useRealTimers();
  });
});
