import { describe, expect, it } from "vitest";
import { GoalValidationError, upsertGoalBlockInMarkdown, validateGoalPatch } from "../../src/gateway/services/goalsStore.js";
import { extractGoalsSection, parseGoals } from "../../src/gateway/services/workspaceGoals.js";

const IDENTITY = `# Identity

## Goals

### G1 — Ship v2
- Level: L1
- Status: on-track
- Priority: 1
- Structure: keep me

#### G2 — Fix latency (Parent: G1)
- Level: L2
- Status: completed
- Priority: 1

## Domain Context
stuff
`;

describe("goalsStore validation", () => {
  it("normalises synonyms and rejects junk", () => {
    expect(validateGoalPatch({ status: "completed" }).status).toBe("done");
    expect(validateGoalPatch({ status: "In Progress" }).status).toBe("on-track");
    expect(() => validateGoalPatch({ status: "kinda done" })).toThrow(GoalValidationError);
    expect(() => validateGoalPatch({ level: "L4" })).toThrow(/level/);
    expect(() => validateGoalPatch({ period: "Q3" })).toThrow(/period/);
    expect(() => validateGoalPatch({ title: "x", level: "L2" }, { creating: true })).toThrow(/parent/);
    expect(() => validateGoalPatch({ entities: ["not a ref"] })).toThrow(/entities/);
  });
});

describe("IDENTITY.md mirror", () => {
  it("updates an existing block in place, keeping extra lines and the Parent heading", () => {
    const out = upsertGoalBlockInMarkdown(IDENTITY, { id: "G2", title: "Fix latency", level: "L2", parent_id: "G1", status: "done", priority: 1, closed: "2026-10-12", outcome: "Shipped" });
    const goals = parseGoals(extractGoalsSection(out)!);
    const g2 = goals.find((g) => g.id === "G2")!;
    expect(g2).toMatchObject({ status: "done", parent: "G1", closed: "2026-10-12", outcome: "Shipped" });
    expect(out).not.toMatch(/- Parent:/);
    expect(out).toContain("- Structure: keep me");
    expect(out).toContain("## Domain Context\nstuff");
  });

  it("appends a new block at the end of ## Goals", () => {
    const out = upsertGoalBlockInMarkdown(IDENTITY, { id: "G3", title: "New thing", level: "L2", parent_id: "G1", status: "proposed", confidence: "medium", priority: 99, opened: "2026-10-12" });
    const goals = parseGoals(extractGoalsSection(out)!);
    expect(goals.map((g) => g.id)).toEqual(["G1", "G2", "G3"]);
    expect(goals[2]).toMatchObject({ level: "L2", parent: "G1", status: "proposed" });
    expect(out.indexOf("G3 — New thing")).toBeLessThan(out.indexOf("## Domain Context"));
  });

  it("blanks Closed when a goal is reopened", () => {
    const closed = upsertGoalBlockInMarkdown(IDENTITY, { id: "G1", title: "Ship v2", level: "L1", status: "done", closed: "2026-10-01" });
    const reopened = upsertGoalBlockInMarkdown(closed, { id: "G1", title: "Ship v2", level: "L1", status: "on-track", closed: null });
    expect(parseGoals(extractGoalsSection(reopened)!)[0]).toMatchObject({ status: "on-track", closed: undefined });
  });
});
