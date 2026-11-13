/**
 * /api/focus/* — the Focus DB for jobs and scripts (save_brief.py, trackers).
 *
 * Loopback only. No app id, no data-source lookup: the server knows where Focus lives.
 * Writes are fixed statements, not SQL from the caller, so a job cannot touch other tables.
 */
import type { Express, Request, Response } from "express";
import { isLoopbackRequest } from "../utils/isLoopbackRequest.js";

/** Tell the Focus page (and anything else listening) that Focus data changed. */
async function changed(what: "brief" | "reviews"): Promise<void> {
  try {
    const { broadcast } = await import("../websocket/index.js");
    broadcast({ type: "focus:changed", data: { what } });
  } catch {
    /* no websocket yet (tests, early boot) */
  }
}

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
      void changed("brief");
      return { ok: true, date: rows[0]!.date, bytes: Number(rows[0]!.len) };
    });
  });

  // The Focus page: the last 30 briefs (newest first) and every review, in one call.
  app.get("/api/focus/today", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const { ensureFocusDb, focusQuery } = await import("./focusDb.js");
      await ensureFocusDb().catch(() => undefined);
      const briefs = await focusQuery(
        "SELECT date, brief_json FROM briefs WHERE brief_json IS NOT NULL ORDER BY date DESC LIMIT 30",
      ).catch(() => []);
      const reviews = await focusQuery("SELECT item_key, status, note, updated_at FROM brief_reviews").catch(() => []);
      return { briefs, reviews };
    });
  });

  // Check (complete) / x (irrelevant + note) on one brief item. The brief job reads these back.
  app.put("/api/focus/reviews/:key", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const status = b.status === "complete" || b.status === "irrelevant" ? b.status : null;
      if (!status) throw bad("status must be complete or irrelevant");
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str(b.briefDate))) throw bad("briefDate must be YYYY-MM-DD");
      const { focusWrite } = await import("./focusDb.js");
      await focusWrite(
        `INSERT INTO brief_reviews (item_key, brief_date, section, item_type, title, status, note, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(item_key) DO UPDATE SET status = excluded.status, note = excluded.note, task_id = excluded.task_id, updated_at = datetime('now')`,
        [String(req.params.key), str(b.briefDate), str(b.section), str(b.itemType), str(b.title), status, str(b.note) || null, str(b.taskId) || null],
      );
      void changed("reviews");
      return { ok: true };
    });
  });

  app.delete("/api/focus/reviews/:key", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const { focusWrite } = await import("./focusDb.js");
      await focusWrite("DELETE FROM brief_reviews WHERE item_key = ?", [String(req.params.key)]);
      void changed("reviews");
      return { ok: true };
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

  // Open asks: teammates' asks to you (Pen + Jev ranked) and your asks to them. The brief's input for
  // one plan (asks compete with tasks) and for Waiting on (skip anything already a tracked ask).
  app.get("/api/focus/open-asks", (req, res) => {
    if (!guard(req, res)) return;
    void run(res, async () => {
      const { openAsks, waitingOn } = await import("./collab/mentions.js");
      const slim = (m: { id: string; fromName: string; toName: string; text: string; action: { title: string; due?: string | null } | null; createdAt: string }) =>
        ({ id: m.id, from: m.fromName, to: m.toName, what: m.action?.title ?? m.text.slice(0, 200), due: m.action?.due ?? null, at: m.createdAt });
      const [toYou, fromYou] = await Promise.all([openAsks().catch(() => []), waitingOn().catch(() => [])]);
      return {
        to_you: toYou.map((m) => ({ ...slim(m), triage: m.triage ?? null })),
        from_you: fromYou.map((m) => ({ ...slim(m), progress: m.progress ?? "asked" })),
      };
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
