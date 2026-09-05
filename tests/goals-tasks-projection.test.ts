import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  isGoalsTasksSourcePath,
  parseEntityGoals,
  parseOpenItemTasks,
  projectWorkspace,
} from "../src/gateway/services/goalsTasksProjection.js";
import {
  setGoalStatusInMarkdown,
  toggleOpenItemInMarkdown,
} from "../src/gateway/services/workspaceTasks.js";

const IDENTITY = `# Identity

## Goals

### G1 — Grow Papr Work into a revenue business
- Level: L1
- Status: on-track
- Confidence: high
- Priority: 1
- Period: 2026

### G3 — Close 2 channel-partner deals via RR
- Level: L2
- Status: proposed
- Confidence: high
- Priority: 1
- Parent: G1
- Entities: projects/rr-partnership, people/justin-jones
- Period: 2026-Q3

### G7 — Send MSA to Justin
- Level: L3
- Status: proposed
- Confidence: high
- Priority: 1
- Parent: G3
- Next milestone: by 2026-09-12

### G8 — Old tactical, done
- Level: L3
- Status: done
- Parent: G3
- Closed: 2026-09-01

## Domain Context
`;

const ARCHIVE = `# Goals archive

## 2026-Q2

### G2 — Old L1
- Level: L1
- Status: dropped
- Closed: 2026-06-28
- Outcome: Deprioritised for RR
`;

const JUSTIN = `---
id: justin-jones
goals: [G3]
---
# Justin Jones

## Open Items

- [ ] [user] Chase signed MSA (by 2026-09-10) (G3)
- [x] [agent] Draft partner one-pager (G3)
- [ ] Untagged thing (no-goal)
- [ ] (no open items)

## Changelog
`;

const RR = `---
id: rr-partnership
goals:
  - G3
  - G1
---
# RR partnership

## Open Items

- [ ] [user] Draft channel pricing sheet
`;

const input = {
  identity: IDENTITY,
  archive: ARCHIVE,
  entities: { "entities/people/justin-jones.md": JUSTIN, "entities/projects/rr-partnership.md": RR },
};

/** In-memory SQLite-ish fake: enough for upsert/select semantics the projection uses. */
function fakeDb() {
  const goals = new Map<string, Record<string, unknown>>();
  const tasks = new Map<string, Record<string, unknown>>();
  const history: Record<string, unknown>[] = [];
  const links = new Map<string, Record<string, unknown>>();
  const exec = async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO goal_entities")) {
      const [id, goal_id, entity_ref, entity_type, source] = params;
      links.set(String(id), { id, goal_id, entity_ref, entity_type, source });
      return;
    }
    if (sql.startsWith("DELETE FROM goal_entities")) {
      links.delete(String(params[0]));
      return;
    }
    if (sql.startsWith("INSERT OR REPLACE INTO goal_history")) {
      const [id, goal_id, changed_at, field, old_value, new_value] = params;
      history.push({ id, goal_id, changed_at, field, old_value, new_value });
    } else if (sql.startsWith("INSERT INTO goals")) {
      const [id, title, level, parent_id, status, confidence, priority, period, opened, closed, next_milestone, owner, evidence, mentions, outcome, archived, parent_missing, source_file] = params;
      goals.set(String(id), { id, title, level, parent_id, status, confidence, priority, period, opened, closed, next_milestone, owner, evidence, mentions, outcome, archived, parent_missing, source_file });
    } else if (sql.startsWith("INSERT INTO tasks")) {
      const [id, title, status, owner, due, goal_id, goal_source, entity_ref, source, source_file, source_line] = params;
      const prev = tasks.get(String(id));
      tasks.set(String(id), { id, title, status, owner, due, goal_id, goal_source, entity_ref, source, source_file, source_line, completed_at: status === "done" ? (prev?.completed_at ?? "now") : null });
    } else if (sql.startsWith("UPDATE tasks SET status = 'dropped'")) {
      const id = String(params[1]);
      const t = tasks.get(id);
      if (t) t.status = "dropped";
    } else {
      throw new Error(`fake exec: unhandled ${sql.slice(0, 40)}`);
    }
  };
  const query = async (sql: string) => {
    if (sql.startsWith("SELECT * FROM goals")) return [...goals.values()];
    if (sql.startsWith("SELECT id, status FROM tasks WHERE status = 'open'"))
      return [...tasks.values()].filter((t) => t.status === "open");
    if (sql.startsWith("SELECT id FROM goal_entities")) return [...links.values()];
    throw new Error(`fake query: unhandled ${sql}`);
  };
  return { goals, tasks, history, links, exec, query };
}

describe("goals + tasks projection (pure)", () => {
  it("projects active + archived goals and marks archive rows", () => {
    const snap = projectWorkspace(input);
    const byId = Object.fromEntries(snap.goals.map((g) => [g.id, g]));
    expect(Object.keys(byId).sort()).toEqual(["G1", "G2", "G3", "G7", "G8"]);
    expect(byId.G1).toMatchObject({ level: "L1", archived: 0, source_file: "IDENTITY.md", period: "2026" });
    expect(byId.G2).toMatchObject({ level: "L1", archived: 1, source_file: "goals/archive.md", status: "dropped", outcome: "Deprioritised for RR" });
    expect(byId.G7).toMatchObject({ parent_id: "G3", parent_missing: 0 });
  });

  it("turns L3 goals and entity Open Items into tasks with stable ids", () => {
    const snap = projectWorkspace(input);
    const l3 = snap.tasks.filter((t) => t.source === "l3-goal");
    expect(l3.map((t) => [t.id, t.status, t.goal_id, t.due])).toEqual([
      ["goal:G7", "open", "G3", "2026-09-12"],
      ["goal:G8", "done", "G3", null],
    ]);
    const items = snap.tasks.filter((t) => t.source === "open-item");
    // "(no open items)" placeholder is skipped; Justin's three real checkboxes + RR's one are kept.
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      title: "Chase signed MSA (by 2026-09-10)",
      status: "open",
      owner: "user",
      due: "2026-09-10",
      goal_id: "G3",
      entity_ref: "people/justin-jones",
      source_line: 0,
    });
    expect(items[1]).toMatchObject({ status: "done", owner: "agent", source_line: 1 });
    expect(items[2]).toMatchObject({ owner: "unknown", goal_id: "G3", goal_source: "entity", source_line: 2 });
    expect(items[0].goal_source).toBe("tag");
    expect(items[0].id).toMatch(/^item:[0-9a-f]{16}$/);
    // Same title on the same entity → same id (idempotent across runs).
    const again = parseOpenItemTasks(JUSTIN, "people/justin-jones", "entities/people/justin-jones.md");
    expect(again[0].id).toBe(items[0].id);
  });

  it("IDENTITY wins over the archive when a goal is reopened", () => {
    const reopened = {
      ...input,
      identity: IDENTITY.replace("## Domain Context", "### G2 — Old L1\n- Level: L1\n- Status: on-track\n- Period: 2026-Q4\n\n## Domain Context"),
    };
    const snap = projectWorkspace(reopened);
    const g2 = snap.goals.filter((g) => g.id === "G2");
    expect(g2).toHaveLength(1);
    expect(g2[0]).toMatchObject({ archived: 0, status: "on-track", period: "2026-Q4" });
  });

  it("applySnapshot upserts, writes history only on change, and drops vanished open tasks", async () => {
    const db = fakeDb();
    const first = await applySnapshot(projectWorkspace(input), db.exec, db.query, "2026-09-04T10:00:00Z");
    expect(first.goalsUpserted).toBe(5);
    expect(first.historyRows).toBe(5); // one "created" row per goal
    expect(db.tasks.size).toBe(6);
    expect(db.links.size).toBe(3); // G3↔project (both), G3↔justin (both), G1↔project (entity side)

    // Second run, nothing changed → no new history.
    const second = await applySnapshot(projectWorkspace(input), db.exec, db.query, "2026-09-05T10:00:00Z");
    expect(second.historyRows).toBe(0);
    expect(second.tasksDropped).toBe(0);

    // User confirms G3 and Justin's first open item is removed from the page.
    const changed = {
      ...input,
      identity: IDENTITY.replace("### G3 — Close 2 channel-partner deals via RR\n- Level: L2\n- Status: proposed", "### G3 — Close 2 channel-partner deals via RR\n- Level: L2\n- Status: on-track"),
      entities: { ...input.entities, "entities/people/justin-jones.md": JUSTIN.replace("- [ ] [user] Chase signed MSA (by 2026-09-10) (G3)\n", "") },
    };
    const third = await applySnapshot(projectWorkspace(changed), db.exec, db.query, "2026-09-06T10:00:00Z");
    expect(third.historyRows).toBe(1);
    expect(db.history.at(-1)).toMatchObject({ goal_id: "G3", field: "status", old_value: "proposed", new_value: "on-track" });
    expect(third.tasksDropped).toBe(1);
    const dropped = [...db.tasks.values()].find((t) => t.status === "dropped");
    expect(dropped?.title).toBe("Chase signed MSA (by 2026-09-10)");
  });

  it("links goals ↔ entities from both sides and inherits goals onto untagged tasks only when unambiguous", () => {
    expect(parseEntityGoals(JUSTIN)).toEqual(["G3"]);
    expect(parseEntityGoals(RR)).toEqual(["G3", "G1"]);
    expect(parseEntityGoals("# no frontmatter\n")).toEqual([]);
    const snap = projectWorkspace(input);
    const byId = Object.fromEntries(snap.goalEntities.map((l) => [l.id, l]));
    expect(byId["G3|projects/rr-partnership"]).toMatchObject({ source: "both", entity_type: "projects" });
    expect(byId["G3|people/justin-jones"]).toMatchObject({ source: "both", entity_type: "people" });
    expect(byId["G1|projects/rr-partnership"]).toMatchObject({ source: "entity" });
    expect(Object.keys(byId)).toHaveLength(3);
    // RR page serves two goals → its untagged item stays untraced (must be tagged explicitly).
    const rrTask = snap.tasks.find((t) => t.entity_ref === "projects/rr-partnership")!;
    expect(rrTask.goal_id).toBeNull();
    expect(rrTask.goal_source).toBeNull();
    // Goal-side links survive when the page has no frontmatter at all.
    const bare = projectWorkspace({ ...input, entities: { "entities/people/justin-jones.md": JUSTIN.replace("goals: [G3]\n", "") } });
    expect(bare.goalEntities.find((l) => l.id === "G3|people/justin-jones")?.source).toBe("goal");
    // Unknown goal ids in frontmatter are ignored rather than creating dangling links.
    const dangling = projectWorkspace({ ...input, entities: { "entities/people/x.md": "---\nid: x\ngoals: [G99]\n---\n" } });
    expect(dangling.goalEntities.some((l) => l.goal_id === "G99")).toBe(false);
  });

  it("only re-projects on goal/entity source paths", () => {
    expect(isGoalsTasksSourcePath("IDENTITY.md")).toBe(true);
    expect(isGoalsTasksSourcePath("goals/archive.md")).toBe(true);
    expect(isGoalsTasksSourcePath("entities/people/x.md")).toBe(true);
    expect(isGoalsTasksSourcePath("entities/people/x.md.backup.123")).toBe(false);
    expect(isGoalsTasksSourcePath("memory/2026-09-04.md")).toBe(false);
    expect(isGoalsTasksSourcePath("MEMORY.md")).toBe(false);
  });
});

describe("task completion write-back", () => {
  it("ticks the Nth checkbox under Open Items without touching other sections", () => {
    const out = toggleOpenItemInMarkdown(JUSTIN, 2, true)!;
    expect(out).toContain("- [x] Untagged thing (no-goal)");
    expect(out).toContain("- [ ] [user] Chase signed MSA");
    expect(out.split("## Changelog")[1]).toBe(JUSTIN.split("## Changelog")[1]);
    expect(toggleOpenItemInMarkdown(JUSTIN, 99, true)).toBeNull();
    expect(toggleOpenItemInMarkdown("# no section\n", 0, true)).toBeNull();
  });

  it("sets an L3 block to done with Closed + Outcome, and back to on-track", () => {
    const done = setGoalStatusInMarkdown(IDENTITY, "G7", "done", "2026-09-04", "MSA sent")!;
    const block = done.slice(done.indexOf("### G7"), done.indexOf("### G8"));
    expect(block).toMatch(/- Status: done/);
    expect(block).toMatch(/- Closed: 2026-09-04/);
    expect(block).toMatch(/- Outcome: MSA sent/);
    // Other blocks untouched.
    expect(done.slice(done.indexOf("### G3"), done.indexOf("### G7"))).toBe(IDENTITY.slice(IDENTITY.indexOf("### G3"), IDENTITY.indexOf("### G7")));
    const reopened = setGoalStatusInMarkdown(done, "G7", "on-track", "2026-09-05")!;
    expect(reopened.slice(reopened.indexOf("### G7"), reopened.indexOf("### G8"))).toMatch(/- Status: on-track[\s\S]*- Closed: —/);
    expect(setGoalStatusInMarkdown(IDENTITY, "G99", "done", "2026-09-04")).toBeNull();
  });
});

describe("Home migration + contract", () => {
  const home = join(process.cwd(), "src/resources/default-apps/home-dashboard");
  it("0003 creates goals, goal_history, tasks and adds task_id to brief_reviews", () => {
    const sql = readFileSync(join(home, "db-migrations/0003_goals_tasks.sql"), "utf8");
    for (const t of ["goals", "goal_history", "tasks"]) expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
    expect(sql).toMatch(/ALTER TABLE brief_reviews ADD COLUMN task_id TEXT/);
    expect(sql).toMatch(/id TEXT PRIMARY KEY/);
    const sql4 = readFileSync(join(home, "db-migrations/0004_goal_entities.sql"), "utf8");
    expect(sql4).toMatch(/CREATE TABLE IF NOT EXISTS goal_entities \(/);
    expect(sql4).toMatch(/ALTER TABLE tasks ADD COLUMN goal_source TEXT/);
  });
  it("brief reads tasks as the candidate pool and stamps task_id; Home completes tasks at source", () => {
    const def = JSON.parse(readFileSync(join(home, "default-job.json"), "utf8")) as { command: string };
    expect(def.command).toContain('python3 "$JOB_DIR/save_brief.py" --tasks');
    expect(def.command).toMatch(/\*\*Stamp `task_id` on every priority/);
    expect(def.command).toMatch(/"task_id": "item:/);
    const py = readFileSync(join(home, "job-assets/save_brief.py"), "utf8");
    expect(py).toMatch(/def print_tasks/);
    expect(py).toMatch(/FROM tasks t LEFT JOIN goals g/);
    const reviews = readFileSync(join(home, "reviews.js"), "utf8");
    expect(reviews).toMatch(/\/api\/workspace\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/done/);
    expect(reviews).toMatch(/task_id = excluded\.task_id/);
  });
});
