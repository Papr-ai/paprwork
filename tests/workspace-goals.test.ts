import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGoalTree,
  extractGoalsSection,
  parseArchive,
  parseEntityRefs,
  parseGoals,
} from "../src/gateway/services/workspaceGoals.js";

const template = readFileSync(
  join(process.cwd(), "src/resources/workspace-templates/IDENTITY.md"),
  "utf8",
);

const TREE = `## Goals

### G1 — Grow Papr Work into a revenue business
- Level: L1
- Status: on-track
- Confidence: high
- Priority: 1
- Parent: —
- Next milestone: 3 paying teams (by 2026-10-31)

### G2 — Ship Papr Memory as a platform
- Level: L1
- Status: proposed
- Confidence: medium
- Priority: 2

### G3 — Close 2 channel-partner deals via Revenue Reimagined
- Level: L2
- Status: proposed
- Confidence: high
- Priority: 1
- Parent: G1
- Evidence: > "we need to close two partner deals" — Chats/RR.txt · mentions: 4 (7d)

### G4 — MyAdvice audit → renewal
- Level: L2
- Status: on-track
- Priority: 2
- Parent: G1

### G5 — Send MSA to Justin
- Level: L3
- Status: proposed
- Confidence: high
- Priority: 1
- Parent: G3
- Next milestone: by 2026-09-12

### G6 — Orphan tactical thing
- Level: L3
- Status: proposed
- Confidence: low
- Parent: G9

## Domain Context
`;

describe("workspaceGoals parser (L1/L2/L3 + confidence + priority)", () => {
  it("treats the shipped IDENTITY.md template as empty (example block is fenced)", () => {
    const section = extractGoalsSection(template);
    expect(section).not.toBeNull();
    expect(parseGoals(section!)).toEqual([]);
    expect(template).toMatch(/\*\*Three levels, one tree\.\*\*/);
    expect(template).toMatch(/\*\*Mutually exclusive\*\*/);
    expect(template).toMatch(/- Confidence: high \| medium \| low/);
  });

  it("parses level, confidence, priority, parent and mention counts", () => {
    const goals = parseGoals(extractGoalsSection(TREE)!);
    const byId = Object.fromEntries(goals.map((g) => [g.id, g]));
    expect(byId.G1).toMatchObject({ level: "L1", confidence: "high", priority: 1, status: "on-track" });
    expect(byId.G1.parent).toBeUndefined();
    expect(byId.G3).toMatchObject({ level: "L2", parent: "G1", confidence: "high", mentions: 4 });
    expect(byId.G4.confidence).toBe("unknown");
    expect(byId.G5).toMatchObject({ level: "L3", parent: "G3" });
  });

  it("flags L2/L3 goals whose parent is missing or the wrong level", () => {
    const goals = parseGoals(extractGoalsSection(TREE)!);
    const g6 = goals.find((g) => g.id === "G6")!;
    expect(g6.parentMissing).toBe(true);
    // L3 pointing at an L1 is also invalid (must be exactly one level up).
    const bad = parseGoals(`### G1 — Root\n- Level: L1\n### G2 — Leaf\n- Level: L3\n- Parent: G1\n`);
    expect(bad.find((g) => g.id === "G2")!.parentMissing).toBe(true);
  });

  it("legacy blocks without Level are L1; a Parent alone implies L2", () => {
    const goals = parseGoals(`### G1 — Old style\n- Status: on-track\n### G2 — Child\n- Status: proposed\n- Parent: G1\n`);
    expect(goals[0].level).toBe("L1");
    expect(goals[1].level).toBe("L2");
    expect(goals[1].parentMissing).toBeUndefined();
  });

  it("builds a priority-ordered tree and keeps orphans visible as roots", () => {
    const tree = buildGoalTree(parseGoals(extractGoalsSection(TREE)!));
    expect(tree.map((n) => n.id)).toEqual(["G1", "G2", "G6"]);
    const g1 = tree[0];
    expect(g1.children.map((n) => n.id)).toEqual(["G3", "G4"]);
    expect(g1.children[0].children.map((n) => n.id)).toEqual(["G5"]);
    expect(tree[2].parentMissing).toBe(true);
  });

  it("parses lifecycle fields and the goals archive grouped by period", () => {
    const active = parseGoals(`### G1 — Thing\n- Level: L1\n- Status: done\n- Period: 2026-Q3\n- Opened: 2026-07-01\n- Closed: 2026-09-30\n- Outcome: Signed two MSAs\n`);
    expect(active[0]).toMatchObject({ status: "done", period: "2026-Q3", opened: "2026-07-01", closed: "2026-09-30", outcome: "Signed two MSAs" });
    const archiveTpl = readFileSync(join(process.cwd(), "src/resources/workspace-templates/goals/archive.md"), "utf8");
    expect(parseArchive(archiveTpl)).toEqual([]);
    const archive = parseArchive(`# Goals archive\n\n## 2026-Q2\n\n### G2 — Old L1\n- Level: L1\n- Status: dropped\n- Closed: 2026-06-28\n- Outcome: Deprioritised for RR\n\n### G4 — Child\n- Level: L2\n- Parent: G2\n- Status: dropped\n\n## 2026-Q1\n\n### G9 — Older\n- Level: L1\n- Status: done\n- Period: 2026-Q1\n`);
    expect(archive.map((g) => [g.id, g.period, g.status])).toEqual([
      ["G2", "2026-Q2", "dropped"],
      ["G4", "2026-Q2", "dropped"],
      ["G9", "2026-Q1", "done"],
    ]);
    // Parent links resolve inside the archive so history keeps its structure.
    expect(archive[1].parentMissing).toBeUndefined();
    expect(template).toMatch(/\*\*Lifecycle & history\.\*\*/);
    expect(template).toMatch(/goals\/archive\.md/);
  });

  it("parses the Entities line into normalized wiki refs", () => {
    expect(parseEntityRefs("projects/rr-partnership, People/Justin-Jones; `companies/acme`")).toEqual([
      "projects/rr-partnership",
      "people/justin-jones",
      "companies/acme",
    ]);
    expect(parseEntityRefs("—")).toEqual([]);
    expect(parseEntityRefs("just-a-slug, projects/")).toEqual([]);
    const goals = parseGoals(`### G1 — X\n- Level: L1\n- Entities: projects/a, people/b\n### G2 — Y\n- Level: L1\n`);
    expect(goals[0].entities).toEqual(["projects/a", "people/b"]);
    expect(goals[1].entities).toBeUndefined();
    expect(template).toMatch(/\*\*Entities — goals live on real things\.\*\*/);
  });

  it("returns null when IDENTITY.md has no Goals heading", () => {
    expect(extractGoalsSection("# Identity\n\n## About\n- x\n")).toBeNull();
  });
});
