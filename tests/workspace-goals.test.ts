import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractGoalsSection,
  parseGoals,
} from "../src/gateway/services/workspaceGoals.js";

const template = readFileSync(
  join(process.cwd(), "src/resources/workspace-templates/IDENTITY.md"),
  "utf8",
);

describe("workspaceGoals parser", () => {
  it("treats the shipped IDENTITY.md template as empty (example block is fenced)", () => {
    const section = extractGoalsSection(template);
    expect(section).not.toBeNull();
    expect(parseGoals(section!)).toEqual([]);
  });

  it("parses populated goal blocks with status and milestone", () => {
    const identity = `# Identity

## About
- Name: Test

## Goals

Intro prose that should be ignored.

### G1 — Close 2 channel-partner deals by Q4
- Status: at-risk
- Next milestone: Send MSA to Justin (by 2026-09-12)
- Owner: user
- Evidence: chat "RR partnership" 2026-08-26

### G2 — MyAdvice audit → renewal
- Status: On Track
- Next milestone: Deliver revised metrics (by 2026-09-05)

### Not a goal heading
- Status: done

## Domain Context
- Stuff
`;
    const goals = parseGoals(extractGoalsSection(identity)!);
    expect(goals).toHaveLength(2);
    expect(goals[0]).toMatchObject({
      id: "G1",
      title: "Close 2 channel-partner deals by Q4",
      status: "at-risk",
      nextMilestone: "Send MSA to Justin (by 2026-09-12)",
      owner: "user",
    });
    expect(goals[0].evidence).toContain("RR partnership");
    // Status normalisation is case/space tolerant.
    expect(goals[1].status).toBe("on-track");
  });

  it("returns null when IDENTITY.md has no Goals heading", () => {
    expect(extractGoalsSection("# Identity\n\n## About\n- x\n")).toBeNull();
  });

  it("does not bleed into the next H2 section", () => {
    const identity = `## Goals
### G1 — A
- Status: done
## Domain Context
### G9 — Should not be parsed
- Status: blocked
`;
    const goals = parseGoals(extractGoalsSection(identity)!);
    expect(goals.map((g) => g.id)).toEqual(["G1"]);
  });
});
