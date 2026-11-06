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

import { fromCloudGoal, mergeOnConflict, shape, GOAL_KEYS, sharedPrefs, withLocalPrefs } from "./focusCloudMap";

describe("conflict merge", () => {
  const base = { goalId: "G1", title: "Ship", status: "on-track", priority: 2 };
  it("keeps my field and their field when we touched different things", () => {
    const r = mergeOnConflict(base, { ...base, status: "at-risk" }, { ...base, priority: 1 });
    expect(r.merged).toMatchObject({ status: "at-risk", priority: 1 });
    expect(r.conflicts).toEqual([]);
  });
  it("theirs wins when both changed the same field, and says so", () => {
    const r = mergeOnConflict(base, { ...base, status: "at-risk" }, { ...base, status: "done" });
    expect(r.merged.status).toBe("done");
    expect(r.conflicts).toEqual(["status"]);
  });
  it("same value on both sides is not a conflict", () => {
    expect(mergeOnConflict(base, { ...base, status: "done" }, { ...base, status: "done" }).conflicts).toEqual([]);
  });
});

describe("cloud → local", () => {
  it("maps a cloud goal back to a Home row", () => {
    const { row, entities } = fromCloudGoal({ goalId: "G7", title: "x", parentId: "G1", archived: true, entities: ["people/sam"] });
    expect(row).toMatchObject({ id: "G7", parent_id: "G1", archived: 1, source_file: "goals/archive.md" });
    expect(entities).toEqual(["people/sam"]);
  });
  it("shape drops server bookkeeping and sorts entities", () => {
    const s = shape(GOAL_KEYS, { goalId: "G1", rev: 4, orgId: "o", entities: ["b", "a"], archived: 0 });
    expect(s.rev).toBeUndefined();
    expect(s.entities).toEqual(["a", "b"]);
    expect(s.archived).toBe(false);
  });
  it("keeps Do Not Disturb and sounds on this device", () => {
    const local = { version: 2, sources: { chats: { sound: false, allow: true } }, types: {}, pauseUntil: "2030-01-01T00:00:00Z" };
    expect(sharedPrefs(local)).toEqual({ version: 2, sources: { chats: { allow: true } }, types: {} });
    const remote = { version: 2, sources: { chats: { allow: false } }, types: {} };
    expect(withLocalPrefs(remote, local)).toEqual({ version: 2, sources: { chats: { allow: false, sound: false } }, types: {}, pauseUntil: "2030-01-01T00:00:00Z" });
  });
});
