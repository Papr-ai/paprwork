import { describe, expect, it } from "vitest";
import { toCloudBrief, toCloudGoal, toCloudTask } from "./focusCloudMap";

describe("Focus rows → cloud shapes", () => {
  it("maps a goal with its entities, sorted, and booleans/numbers", () => {
    const g = toCloudGoal({ id: "G7", title: "Ship pricing", level: "L2", parent_id: "G1", status: "on-track", confidence: "high", priority: "2", next_milestone: "", archived: 0 },
      [{ goal_id: "G7", entity_ref: "projects/web" }, { goal_id: "G1", entity_ref: "x" }, { goal_id: "G7", entity_ref: "people/sam" }]);
    expect(g).toMatchObject({ goalId: "G7", parentId: "G1", priority: 2, nextMilestone: null, archived: false, entities: ["people/sam", "projects/web"] });
  });
  it("maps a task", () => {
    expect(toCloudTask({ id: "item:ab", title: "Call Sam", status: "done", goal_id: "G7", source_line: 3, completed_at: "2026-11-03" }))
      .toMatchObject({ taskId: "item:ab", status: "done", goalId: "G7", sourceLine: 3, completedAt: "2026-11-03", due: null });
  });
  it("parses the brief and attaches that day's reviews only", () => {
    const b = toCloudBrief({ date: "2026-11-03", brief_json: '{"headline":"Ship"}' },
      [{ brief_date: "2026-11-03", item_key: "k1", section: "s", item_type: "t", title: "x", status: "complete" }, { brief_date: "2026-11-02", item_key: "k0" }]);
    expect(b.brief).toEqual({ headline: "Ship" });
    expect(b.reviews.map((r) => r.itemKey)).toEqual(["k1"]);
    expect(toCloudBrief({ date: "2026-11-03", brief_json: "not json" }).brief).toEqual({ raw: "not json" });
  });
});
