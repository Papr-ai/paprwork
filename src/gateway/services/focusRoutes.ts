/**
 * /api/focus/* — the Focus DB for jobs and scripts (save_brief.py, trackers).
 *
 * Loopback only. No app id, no data-source lookup: the server knows where Focus lives.
 * Writes are fixed statements, not SQL from the caller, so a job cannot touch other tables.
 */
import type { Express, Request, Response } from "express";
import { isLoopbackRequest } from "../utils/isLoopbackRequest.js";

function guard(req: Request, res: Response): boolean {
  if (isLoopbackRequest(req)) return true;
  res.status(403).json({ error: "Focus endpoints are localhost-only" });
  return false;
}

async function run(res: Response, fn: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await fn());
  } catch (error) {
    const e = error as Error & { status?: number };
    res.status(e.status ?? 500).json({ error: e.message });
  }
}

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

export function registerFocusRoutes(app: Express): void {
  // Save one brief. Validated (date key, hero, sections) before it is written, then read back.
  app.post("/api/focus/brief", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const { date, brief } = (req.body ?? {}) as { date?: unknown; brief?: unknown };
      const json = typeof brief === "string" ? brief : JSON.stringify(brief ?? null);
      const { validateDailyBriefWrite } = await import("../../core/utils/dailyBriefPayload.js");
      const check = validateDailyBriefWrite(date, json);
      if (!check.ok) throw bad(check.error);
      const { ensureFocusDb, focusQuery, focusWrite } = await import("./focusDb.js");
      await ensureFocusDb();
      await focusWrite("INSERT OR REPLACE INTO briefs (date, brief_json, created_at) VALUES (?, ?, datetime('now'))", [date, json]);
      const rows = await focusQuery("SELECT date, length(brief_json) AS len FROM briefs WHERE date = ?", [date]);
      if (!rows.length) throw new Error(`write reported success but no row exists for ${String(date)}`);
      void import("./focusCloud/focusCloudSync.js").then((m) => m.scheduleFocusCloudSync(`brief ${String(date)}`)).catch(() => undefined);
      return { ok: true, date: rows[0]!.date, bytes: Number(rows[0]!.len) };
    });
  });

  // Feedback on past briefs (check / x + note), newest first.
  app.get("/api/focus/brief-reviews", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
      const { focusQuery } = await import("./focusDb.js");
      const rows = await focusQuery(
        "SELECT brief_date, section, item_type, title, status, note, updated_at FROM brief_reviews " +
          "WHERE updated_at >= datetime('now', ?) ORDER BY updated_at DESC",
        [`-${days} days`],
      ).catch(() => []);
      return { rows };
    });
  });

  // Open tasks with their goal chain: the candidate pool for the brief's priorities.
  app.get("/api/focus/open-tasks", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const { focusQuery } = await import("./focusDb.js");
      const rows = await focusQuery(
        "SELECT t.id, t.title, t.owner, t.due, t.goal_id, t.entity_ref, t.source, " +
          "g.title AS goal_title, g.level AS goal_level, g.parent_id AS goal_parent, " +
          "g.status AS goal_status, g.confidence AS goal_confidence, g.priority AS goal_priority " +
          "FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id WHERE t.status = 'open' " +
          "ORDER BY CASE WHEN t.due IS NULL THEN 1 ELSE 0 END, t.due, COALESCE(g.priority, 99), t.title",
      ).catch(() => []);
      return { rows };
    });
  });

  // Find or create the Daily Brief job (the "Generate brief" button uses this).
  app.post("/api/focus/brief-job", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const { ensureDailyBriefJob } = await import("./focusSystemJobs.js");
      const jobId = await ensureDailyBriefJob();
      if (!jobId) throw new Error("Daily Brief job bundle not found");
      return { jobId };
    });
  });
}
