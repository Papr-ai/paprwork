import { beforeEach, describe, expect, it, vi } from "vitest";
import { _clearNeedsGoals, goalsForNeeds } from "./needsGoals.js";
import type { JevFn } from "./focusAttribution.js";

const goals = [
  { id: "g8", title: "G8 Update pricing plans", scope: "pricing page, plans, FAQ, copy" },
  { id: "g4", title: "G4 Retention", scope: "L28, churn, cohort definitions" },
];

describe("goalsForNeeds", () => {
  beforeEach(() => _clearNeedsGoals());

  it("tags confident items, abstains on weak ones, strips the G-prefix", async () => {
    const jev = vi.fn<JevFn>(async () => ({
      item_1: { choice: "g8", probabilities: { g8: 0.93, g4: 0.04, NONE: 0.03 } },
      item_2: { choice: "g4", probabilities: { g8: 0.3, g4: 0.45, NONE: 0.25 } },
    }));
    const out = await goalsForNeeds(goals, [{ key: "a", text: "Write the pricing page FAQ" }, { key: "b", text: "Lunch on Friday?" }], jev);
    expect(out.a).toEqual({ goalId: "g8", title: "Update pricing plans", p: 0.93 });
    expect(out.b).toBeNull();
  });

  it("asks Jev once per item text; edits and goal changes re-ask", async () => {
    const jev = vi.fn<JevFn>(async (_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, { choice: "g8", confidence: 0.9 }])));
    const items = [{ key: "a", text: "Write the pricing page FAQ" }];
    await goalsForNeeds(goals, items, jev);
    await goalsForNeeds(goals, items, jev);
    expect(jev).toHaveBeenCalledTimes(1);
    await goalsForNeeds(goals, [{ key: "a", text: "Write the pricing page FAQ by Thu" }], jev);
    await goalsForNeeds([...goals, { id: "g9", title: "Hiring" }], items, jev);
    expect(jev).toHaveBeenCalledTimes(3);
  });

  it("no goals → no Jev call, all null", async () => {
    const jev = vi.fn<JevFn>();
    expect(await goalsForNeeds([], [{ key: "a", text: "x" }], jev)).toEqual({ a: null });
    expect(jev).not.toHaveBeenCalled();
  });
});
