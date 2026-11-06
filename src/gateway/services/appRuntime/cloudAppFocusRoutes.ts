/**
 * apps.papr.ai Focus API: the same routes the Focus page calls on the desktop gateway, under /focus-api,
 * answered from the memory server's Focus store with the visitor's session (never a key in the browser).
 *
 *   GET  /focus-api/api/focus/today            briefs + reviews
 *   PUT|DELETE /focus-api/api/focus/reviews/:k  check / x / undo on a brief item
 *   GET|PUT /focus-api/api/workspace/focus      Your three (desktop-scored; web picks apply on top)
 *   POST /focus-api/api/workspace/focus/repick
 *   GET  /focus-api/api/workspace/goals         PATCH /focus-api/api/workspace/goals/:id
 *   GET  /focus-api/api/workspace/tasks         POST  /focus-api/api/workspace/tasks/:id/done
 *   GET  /focus-api/feed                        mentions: asks of you + Waiting on
 *   POST /focus-api/feed/answer | /feed/followup
 * Anything that needs the desktop (generate a brief, build a tracker) answers 409 with a plain reason.
 */
import express, { type Express, type Request, type Response } from "express";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { runtimeFetch } from "./memoryRuntimeClient.js";
import type { DiscoverSessionReader } from "./cloudAppDiscoverPage.js";
import { applyPicks, toFeed, toFocusState, toGoals, toTasks, toToday, withReview, type Row } from "./cloudAppFocusMap.js";

const DESKTOP = "Open Papr Work on your computer for this. The web shows what your desktop last synced.";

class HttpError extends Error { constructor(public status: number, message: string, public body?: Row) { super(message); } }

async function mem(token: string, path: string, method = "GET", body?: unknown): Promise<Row> {
  const res = await runtimeFetch(`${getMemoryServerBaseUrl()}/v1/cloud/collab${path}`, {
    method, headers: { "X-Session-Token": token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, 15_000);
  const json = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) throw new HttpError(res.status, String(json.detail ?? `memory ${res.status}`), json);
  return json;
}

export function registerFocusRoutes(app: Express, session: DiscoverSessionReader): void {
  const r = express.Router();
  r.use(express.json({ limit: "256kb" }));
  r.use((req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    const token = session.getSessionToken(req);
    if (!token) { res.status(401).json({ error: "Sign in to see Focus" }); return; }
    (req as Request & { token: string }).token = token;
    next();
  });
  const h = (fn: (req: Request, t: string) => Promise<unknown>) => (req: Request, res: Response) => {
    fn(req, (req as Request & { token: string }).token)
      .then((out) => res.json(out ?? { ok: true }))
      .catch((e: Error) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status >= 500) console.warn("[CloudAppHost] focus:", e.message.slice(0, 200));
        res.status(status).json({ error: status === 404 ? "Focus isn't on this server yet" : e.message });
      });
  };

  r.get("/api/focus/today", h(async (_q, t) => toToday(((await mem(t, "/focus/briefs?limit=30")).briefs as Row[]) ?? [])));

  // A review lives on its brief: read it, change the one item, write it back with its rev.
  const review = async (t: string, key: string, date: string, next: Row | null) => {
    for (let i = 0; i < 2; i++) {
      const b = ((await mem(t, `/focus/briefs/${encodeURIComponent(date)}`)).brief ?? null) as Row | null;
      if (!b) throw new HttpError(404, "That brief isn't synced yet");
      try {
        await mem(t, `/focus/briefs/${encodeURIComponent(date)}`, "PUT", { reviews: withReview(b.reviews as Row[], key, next), rev: b.rev });
        return;
      } catch (e) { if (!(e instanceof HttpError && e.status === 409)) throw e; }
    }
  };
  r.put("/api/focus/reviews/:key", h(async (req, t) => {
    const b = req.body as Row;
    if (typeof b.briefDate !== "string") throw new HttpError(400, "briefDate required");
    await review(t, String(req.params.key), b.briefDate, {
      section: b.section, itemType: b.itemType, title: b.title, status: b.status, note: b.note ?? null, taskId: b.taskId ?? null,
    });
  }));
  r.delete("/api/focus/reviews/:key", h(async (req, t) => {
    const key = String(req.params.key);
    const date = String(req.query.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date required");
    await review(t, key, date, null);
  }));

  const three = async (t: string) => ((await mem(t, "/focus/three")).three ?? null) as Row | null;
  r.get("/api/workspace/focus", h(async (_q, t) => {
    const s = toFocusState(await three(t));
    if (!s) throw new HttpError(404, "Your three haven't synced yet");
    return s;
  }));
  r.put("/api/workspace/focus", h(async (req, t) => {
    const picks = ((req.body as Row).picks as Row[] | undefined) ?? [];
    const cur = await three(t);
    await mem(t, "/focus/three", "PUT", { picks, picksBy: "web", repick: false, rev: cur?.rev ?? null });
    return applyPicks((cur?.state as Row) ?? { three: [], candidates: [] }, picks);
  }));
  r.post("/api/workspace/focus/repick", h(async (_q, t) => {
    const cur = await three(t);
    const picks = ((cur?.state as Row | undefined)?.three as Row[] | undefined)?.map((g) => ({ id: g.id, goalId: g.id })) ?? [];
    if (!picks.length) throw new HttpError(409, DESKTOP);
    await mem(t, "/focus/three", "PUT", { picks, picksBy: "web", repick: true, rev: cur?.rev ?? null });
    return toFocusState(cur);
  }));
  r.post("/api/workspace/focus/tracker", h(async () => { throw new HttpError(409, DESKTOP); }));
  r.post("/api/focus/brief-job", h(async () => { throw new HttpError(409, DESKTOP); }));

  r.get("/api/workspace/goals", h(async (_q, t) => toGoals(((await mem(t, "/focus/goals")).goals as Row[]) ?? [])));
  r.patch("/api/workspace/goals/:id", h(async (req, t) => {
    const gid = String(req.params.id).toUpperCase();
    const cur = (((await mem(t, "/focus/goals")).goals as Row[]) ?? []).find((g) => g.goalId === gid);
    if (!cur) throw new HttpError(404, "Goal not found");
    const b = req.body as Row;
    const fields = Object.fromEntries(["status", "confidence", "priority", "title", "nextMilestone"].filter((k) => k in b).map((k) => [k, b[k]]));
    await mem(t, "/focus/goals", "PUT", { goalId: gid, ...fields, rev: cur.rev });
  }));

  r.get("/api/workspace/tasks", h(async (_q, t) => toTasks(((await mem(t, "/focus/tasks")).tasks as Row[]) ?? [])));
  r.post("/api/workspace/tasks/:id/done", h(async (req, t) => {
    const tid = String(req.params.id);
    const cur = (((await mem(t, "/focus/tasks")).tasks as Row[]) ?? []).find((x) => x.taskId === tid);
    if (!cur) throw new HttpError(404, "Task not found");
    const done = (req.body as Row).done !== false;
    await mem(t, "/focus/tasks", "PUT", { taskId: tid, key: cur.key, status: done ? "done" : "open", completedAt: done ? new Date().toISOString() : null, rev: cur.rev });
  }));

  r.get("/feed", h(async (_q, t) => {
    const [inbox, sent] = await Promise.all([mem(t, "/mentions?box=inbox&status=open"), mem(t, "/mentions?box=sent&status=open")]);
    return toFeed((inbox.mentions as Row[]) ?? [], (sent.mentions as Row[]) ?? []);
  }));
  r.post("/feed/answer", h(async (req, t) => {
    const b = req.body as Row;
    await mem(t, `/mentions/${encodeURIComponent(String(b.itemId))}/resolve`, "POST", { status: b.status, reply: b.reply ?? null });
  }));
  r.post("/feed/followup", h(async (req, t) => {
    const b = req.body as Row;
    await mem(t, `/mentions/${encodeURIComponent(String(b.itemId))}/followup`, "POST", { kind: b.kind, text: b.text ?? null });
  }));

  app.use("/focus-api", r);
}
