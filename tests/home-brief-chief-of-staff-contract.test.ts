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
    expect(identity).toMatch(/Status: proposed \| on-track \| at-risk \| blocked \| done/);
    expect(identity).toMatch(/\*\*Draft → confirm\.\*\*/);
    expect(identity).toMatch(/never tooling or Papr maintenance/);
  });

  it("SLEEP.md maintains goals and splits user work from system work", () => {
    const sleep = read(join(templates, "SLEEP.md"));
    expect(sleep).toMatch(/4a\. Goals — draft a confidence-scored L1\/L2\/L3 tree/);
    expect(sleep).toMatch(/`Status: proposed`/);
    expect(sleep).toMatch(/Confirmed goals are the user's/);
    expect(sleep).toMatch(/\*\*Seed from what the user already told Papr\.\*\*/);
    expect(sleep).toMatch(/User goals, use cases & Papr Memory \(bootstrap\)/);
    expect(sleep).toMatch(/\*\*L1s must be mutually exclusive\.\*\*/);
    expect(sleep).toMatch(/mentions: N \(7d\)/);
    expect(sleep).toMatch(/## Goal signals/);
    // Lifecycle: override wins, close-don't-delete, archive, period rollover.
    expect(sleep).toMatch(/an override wins/);
    expect(sleep).toMatch(/\*\*Close, don't delete — keep the history\.\*\*/);
    expect(sleep).toMatch(/workspace\/goals\/archive\.md/);
    expect(sleep).toMatch(/\*\*Period rollover\.\*\*/);
    expect(sleep).toMatch(/L1s are never auto-rolled or auto-closed/);
    expect(sleep).toMatch(/\*\*Name the entities each goal runs through\.\*\*/);
    expect(sleep).toMatch(/L2 is usually one project or one company relationship/);
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
    expect(cmd).toMatch(/\*\*Goals are all proposed \(none confirmed\):\*\*/);
    expect(cmd).toMatch(/`Status: proposed`/);
    expect(cmd).toMatch(/\*\*L3s with a date this week are your priority candidates\*\*/);
    expect(cmd).toMatch(/\(G7 → G3 → G1\)/);
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
    // Draft → confirm flow: Sleep proposes, user confirms/rejects from the strip.
    expect(goals).toMatch(/data-goals="draft"/);
    expect(goals).toMatch(/data-goals="confirm"/);
    expect(goals).toMatch(/data-goals="reject"/);
    expect(goals).toMatch(/Status: proposed/);
    expect(css).toContain(".goal.proposed");
    // Hierarchy + confidence rendered; tree comes from the API.
    expect(goals).toMatch(/d\.tree/);
    expect(goals).toMatch(/goal-conf/);
    expect(goals).toMatch(/mutually exclusive/);
    expect(goals).toMatch(/data-goals="close"/);
    expect(goals).toMatch(/entityChips/);
    expect(goals).toMatch(/data-entity=/);
    expect(css).toContain(".goal-entity");
    expect(goals).toMatch(/Past goals/);
    expect(goals).toMatch(/d\.archive/);
    expect(css).toContain(".goals-past");
    for (const cls of [".goal.L1", ".goal.L2", ".goal.L3", ".goal-conf"]) expect(css).toContain(cls);
    expect(app).toMatch(/Goals\.load\(\)/);
    expect(app).toMatch(/Goals\.render\(\)/);
    expect(app).toMatch(/Goals\.bind\(/);
    for (const cls of ["goals-empty", "goals-btn", "goal-next", "goals-grid"]) {
      expect(css, `styles.css missing .${cls}`).toContain(`.${cls}`);
    }
    const meta = JSON.parse(read(join(home, "metadata.json"))) as { version: number };
    expect(meta.version).toBeGreaterThanOrEqual(13);
  });

  it("review feedback (check / x + note) is persisted and fed back into the brief", () => {
    const migration = read(join(home, "db-migrations/0002_brief_reviews.sql"));
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS brief_reviews/);
    expect(migration).toMatch(/item_key TEXT PRIMARY KEY/);
    expect(migration).toMatch(/status IN \('complete', 'irrelevant'\)/);

    const contract = JSON.parse(read(join(home, "data-contract.json"))) as {
      tables: Record<string, { writers: string[] }>;
    };
    expect(contract.tables.brief_reviews.writers).toContain("bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c");

    // App writes through the gateway (never localStorage-only), hydrates on load.
    const reviews = read(join(home, "reviews.js"));
    const app = read(join(home, "app.js"));
    const index = read(join(home, "index.html"));
    expect(index).toContain('<script src="reviews.js"></script>');
    expect(reviews).toContain("/api/db/write");
    expect(reviews).toMatch(/INSERT INTO brief_reviews/);
    expect(reviews).toMatch(/ON CONFLICT\(item_key\) DO UPDATE/);
    expect(app).toMatch(/Reviews\.hydrate\(\)/);
    expect(app).toMatch(/Reviews\.upsert\(/);
    expect(app).toMatch(/Reviews\.remove\(/);
    expect(app).not.toMatch(/localStorage\.setItem/); // moved behind Reviews.setCache

    // Brief job reads feedback via save_brief.py --reviews as a hard input.
    const def = JSON.parse(read(join(home, "default-job.json"))) as { command: string };
    expect(def.command).toContain('python3 "$JOB_DIR/save_brief.py" --reviews');
    expect(def.command).toMatch(/the note is a \*\*standing rule\*\*/);
    expect(def.command).toMatch(/\*\*Respect feedback\.\*\*/);
    const saveBrief = read(join(home, "job-assets/save_brief.py"));
    expect(saveBrief).toMatch(/def print_reviews/);
    expect(saveBrief).toMatch(/FROM brief_reviews/);
    expect(saveBrief).toMatch(/sys\.argv\[1\] == "--reviews"/);

    // Recipe and Sleep close the loop.
    const recipe = read(join(home, "recipe.md"));
    expect(recipe).toMatch(/Respects feedback/);
    expect(recipe).toMatch(/save_brief\.py --reviews/);
    const sleep = read(join(templates, "SLEEP.md"));
    expect(sleep).toMatch(/\*\*Brief feedback\*\*/);
    expect(sleep).toMatch(/`brief_reviews`/);
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
