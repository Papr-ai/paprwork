import { describe, expect, it } from "vitest";
import { onePlan, pickPlan, toFeedAsk, unplanned } from "../components/Focus/page/asks";
import type { BriefItem, Section } from "../components/Focus/page/brief";

const pri = (rank: number, extra: Partial<BriefItem> = {}) => ({ _id: `p${rank}`, rank, title: `P${rank}`, _review: null, _section: "Today's Priorities", _type: "priorities", ...extra }) as BriefItem;
const ask = (id: string, triage: Record<string, unknown> | null = null) =>
  toFeedAsk({ id, fromName: "Shawkat Kabbara", text: `ask ${id}`, action: { title: `Do ${id}` }, createdAt: "2026-11-12T10:00:00Z", triage });

describe("toFeedAsk", () => {
  it("reads Jev's ranking and drops an unknown when", () => {
    const a = ask("a", { when: "today", goalTitle: "G1 Ship Contacts", why: "Release blocked", placed: true, before: "rank:1", planDate: "2026-11-12" });
    expect(a).toMatchObject({ title: "Do a", when: "today", goal: "Ship Contacts", why: "Release blocked", placed: true, before: "rank:1" });
    expect(ask("b", { when: "someday" }).when).toBeNull();
    expect(ask("c").when).toBeNull();
  });
});

describe("one plan", () => {
  const sections = [{ type: "priorities", title: "Today's Priorities", items: [pri(1), pri(2)] }, { type: "intel", title: "Decisions", items: [] }] as unknown as Section[];

  it("takes the priorities out of the brief's sections", () => {
    const { priorities, sections: rest } = pickPlan(sections);
    expect(priorities.map((p) => p.rank)).toEqual([1, 2]);
    expect(rest.map((s) => s.title)).toEqual(["Decisions"]);
  });

  it("slots a placed ask where Jev put it; others wait in All tasks", () => {
    const asks = [ask("a", { when: "now", placed: true, before: "rank:1", planDate: "2026-11-12" }), ask("b", { when: "this_week", placed: false })];
    const plan = onePlan([pri(1), pri(2)], asks, "2026-11-12");
    expect(plan.map((p) => (p.kind === "ask" ? p.ask.id : p.item.rank))).toEqual(["a", 1, 2]);
    expect(unplanned(asks, plan).map((a) => a.id)).toEqual(["b"]);
  });

  it("drops a brief item built from an ask that's been answered, and yesterday's placements", () => {
    const plan = onePlan([pri(1, { mention_id: "gone" }), pri(2)], [ask("old", { when: "today", placed: true, before: "end", planDate: "2026-11-11" })], "2026-11-12");
    expect(plan.map((p) => (p.kind === "ask" ? p.ask.id : p.item.rank))).toEqual([2]);
  });

  it("shows a brief priority made from an open ask as that ask (its reply card)", () => {
    const plan = onePlan([pri(1, { mention_id: "a" })], [ask("a", { when: "today" })], "2026-11-12");
    expect(plan[0]).toMatchObject({ kind: "ask", ask: { id: "a" } });
  });
});
