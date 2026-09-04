import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract for the goal-driven "chief of staff" daily brief pipeline.
 *
 * The Home brief was regressing into a Papr-maintenance to-do list because
 * nothing upstream separated the user's work from system work and there was
 * no goal layer to rank against. These tests pin the pieces that fix that:
 *   IDENTITY.md  → structured ## Goals
 *   SLEEP.md     → User Work / Commitments / Decisions Pending / System Work split
 *   WIKI_WRITER  → goal-linked [user] items + Commitments sections
 *   default-job  → brief prompt reads goals first, caps infra to Overnight
 *   recipe.md    → rubric weights goal traceability, fails chore-list briefs
 */

const root = process.cwd();
const templates = join(root, "src/resources/workspace-templates");
const home = join(root, "src/resources/default-apps/home-dashboard");

const read = (p: string) => readFileSync(p, "utf8");

describe("Chief-of-staff brief pipeline contract", () => {
  it("IDENTITY.md template defines structured outcome goals", () => {
    const identity = read(join(templates, "IDENTITY.md"));
    expect(identity).toMatch(/## Goals/);
    expect(identity).toMatch(/### G1 —/);
    expect(identity).toMatch(/Status: on-track \| at-risk \| blocked \| done/);
    expect(identity).toMatch(/never tooling or Papr maintenance/);
  });

  it("SLEEP.md maintains goals and splits user work from system work", () => {
    const sleep = read(join(templates, "SLEEP.md"));
    expect(sleep).toMatch(/4a\. Goals — maintain `IDENTITY\.md` → `## Goals` every run/);
    for (const section of [
      "## User Work",
      "## Commitments",
      "### Made by user",
      "### Owed to user",
      "## Decisions Pending",
      "## System Work",
      "## What to Watch Tomorrow",
    ]) {
      expect(sleep, `SLEEP.md missing ${section}`).toContain(section);
    }
    expect(sleep).toMatch(/Nothing pressing for the user/);
  });

  it("WIKI_WRITER.md links [user] items to goals and tracks commitments", () => {
    const wiki = read(join(templates, "WIKI_WRITER.md"));
    expect(wiki).toMatch(/Goal linkage \(required on `\[user\]` items\)/);
    expect(wiki).toMatch(/\(no-goal\)/);
    expect(wiki).toMatch(/### Step 3G: Commitments/);
    expect(wiki).toMatch(/### User owes them/);
    expect(wiki).toMatch(/### They owe user/);
    // Classification is judgment-based, not keyword-based.
    expect(wiki).toMatch(/using judgment, not keywords/);
  });

  it("brief prompt reads goals first and confines Papr infra to one Overnight line", () => {
    const def = JSON.parse(read(join(home, "default-job.json"))) as {
      command: string;
    };
    const cmd = def.command;
    expect(cmd).toMatch(/you are the user's chief of staff/);
    expect(cmd).toMatch(/Goals — the lens/);
    expect(cmd).toMatch(/which goal does this serve/);
    expect(cmd).toMatch(/maximum of \*\*3 priorities\*\*/);
    expect(cmd).toMatch(/Papr itself is not the user's job/);
    expect(cmd).toMatch(/"title": "Waiting On"/);
    expect(cmd).toMatch(/"title": "Decisions Pending"/);
    expect(cmd).toMatch(/"title": "Overnight"/);
    expect(cmd).toMatch(/\*\*No goals recorded:\*\*/);
    expect(cmd).toMatch(/Do \*\*not\*\* call `list_jobs\(\)`/);
    // Section types must still be ones render.js knows how to draw.
    const render = read(join(home, "render.js"));
    for (const type of ["priorities", "alerts", "timeline", "intel", "freeform"]) {
      expect(render, `render.js cannot draw ${type}`).toMatch(new RegExp(`\\b${type}\\(`));
      expect(cmd).toContain(`"type": "${type}"`);
    }
    // tracker is optional (numeric goal milestones only) — must still be renderable.
    expect(render).toMatch(/\btracker\(/);
    expect(cmd).toMatch(/`tracker` — optional/);
  });

  it("Home app surfaces goals and lets the user set them through chat", () => {
    const index = read(join(home, "index.html"));
    const goals = read(join(home, "goals.js"));
    const app = read(join(home, "app.js"));
    const css = read(join(home, "styles.css"));
    expect(index).toContain('<div id="goals"></div>');
    expect(index).toContain('<script src="goals.js"></script>');
    expect(goals).toContain("/api/workspace/goals");
    // Goals are edited via the main agent (chat.open), never written by the app directly.
    expect(goals).toMatch(/paprAPI\.invoke\('chat\.open'/);
    expect(goals).not.toMatch(/\/api\/db\/write|fetch\([^)]*method:\s*'P/);
    expect(goals).toMatch(/IDENTITY\.md/);
    expect(goals).toMatch(/data-goals="set"/);
    expect(goals).toMatch(/data-goals="edit"/);
    expect(app).toMatch(/Goals\.load\(\)/);
    expect(app).toMatch(/Goals\.render\(\)/);
    expect(app).toMatch(/Goals\.bind\(/);
    for (const cls of ["goals-empty", "goals-btn", "goal-next", "goals-grid"]) {
      expect(css, `styles.css missing .${cls}`).toContain(`.${cls}`);
    }
    const meta = JSON.parse(read(join(home, "metadata.json"))) as { version: number };
    expect(meta.version).toBeGreaterThanOrEqual(13);
  });

  it("recipe weights goal traceability highest and names chore-list briefs as failing", () => {
    const recipe = read(join(home, "recipe.md"));
    const weights = [...recipe.matchAll(/\|\s*([^|]+?)\s*\|\s*(0\.\d+)\s*\|/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    );
    expect(weights.length).toBeGreaterThanOrEqual(5);
    const total = weights.reduce((s, [, w]) => s + w, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    const [topName, topWeight] = weights.sort((a, b) => b[1] - a[1])[0];
    expect(topName).toMatch(/Goal-traceable priorities/);
    expect(topWeight).toBe(0.3);
    expect(recipe).toMatch(/Priorities about Papr jobs, apps, sync/);
    expect(recipe).toMatch(/save_brief\.py/);
    expect(recipe).not.toMatch(/bash\/sqlite3/);
  });
});
