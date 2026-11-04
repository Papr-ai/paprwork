/**
 * Everything the Focus page reads and writes. All local gateway routes Papr Work owns: no app id,
 * no data-source lookup. Types mirror the gateway (focusGoals / workspaceGoals / workspaceTasks).
 */
import { getGatewayHttpBase } from "../../../utils/gatewayHttpBase";

export type Repeat = "daily" | "weekly";
export interface Signals { chats30?: number; hours7?: number; logDays?: number; openTasks?: number }
export interface MetricsItem { at?: string; source?: string; text?: string; url?: string; image?: string; domain?: string; impressions?: number; engagement?: number; value?: number; unit?: string }
export interface MetricsSource { ok: boolean; error?: string; profile?: { name?: string; handle?: string; url?: string; avatar?: string; followers?: number } }
export interface Metrics {
  updatedAt: string; summary: Record<string, number | null>; labels: Record<string, string>; hero?: string;
  sources?: Record<string, MetricsSource>; history?: (Record<string, number> & { date: string })[]; items?: MetricsItem[];
  display?: { format?: "usd" | "pts" | "percent"; label?: string; line?: string; chart?: { caption: string; bars: { label: string; value: number; tone?: string; title?: string }[] } };
}
export interface Tracker { status: "active" | "ready" | "needs_connect" | "buildable"; title: string; connected?: string[]; missing?: string[]; metrics?: Metrics }
export interface FocusGoal {
  id: string; title: string; origin: string; edited?: boolean; target?: string; due?: string; repeat?: Repeat; scope?: string;
  taskIds?: string[]; tracker?: Tracker; nextStep?: string; why: string; signals?: Signals;
}
export interface FocusState {
  three: FocusGoal[]; candidates: FocusGoal[]; source: "pen" | "user"; confirmed: boolean;
  alignedPct: number | null; evidence: string;
}
export interface FocusPick { id: string; goalId?: string; title?: string; target?: string; due?: string; repeat?: Repeat; scope?: string }

export interface WsGoal {
  id: string; title: string; status: string; level: string; confidence: string; priority: number; parent?: string;
  nextMilestone?: string; period?: string; closed?: string; outcome?: string; entities?: string[]; parentMissing?: boolean;
  children?: WsGoal[];
}
export interface GoalsResult { goals: WsGoal[]; tree: WsGoal[]; isEmpty: boolean; proposedCount: number; archive?: WsGoal[] }

export interface Task { id: string; title: string; status: string; owner: string; due: string | null; goal_id: string | null; entity_ref: string | null }
export interface TasksResult { tasks: Task[]; counts: { open: number; done: number } }

export interface BriefRow { date: string; brief_json: string }
export interface ReviewRow { item_key: string; status: "complete" | "irrelevant"; note: string | null; updated_at: string }

const base = () => getGatewayHttpBase();

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${base()}${path}`, {
    ...rest,
    headers: { "Content-Type": "application/json", "x-papr-actor": "focus", ...(rest.headers ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  // Gateway errors can arrive with HTTP 200 and an { error } body; treat both the same.
  if (!res.ok || (data && typeof data === "object" && "error" in data && data.error)) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export const focusApi = {
  today: () => call<{ briefs: BriefRow[]; reviews: ReviewRow[] }>("/api/focus/today"),
  state: () => call<FocusState>("/api/workspace/focus"),
  goals: () => call<GoalsResult>("/api/workspace/goals"),
  tasks: () => call<TasksResult>("/api/workspace/tasks?status=all"),
  setTaskDone: (id: string, done: boolean) => call(`/api/workspace/tasks/${encodeURIComponent(id)}/done`, { method: "POST", json: { done } }),
  patchGoal: (id: string, body: Record<string, unknown>) => call(`/api/workspace/goals/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
  saveThree: (picks: FocusPick[]) => call<FocusState>("/api/workspace/focus", { method: "PUT", json: { picks, confirm: true } }),
  repick: () => call<FocusState>("/api/workspace/focus/repick", { method: "POST" }),
  startTracker: (goalId: string) => call("/api/workspace/focus/tracker", { method: "POST", json: { goalId } }),
  review: (key: string, body: { briefDate: string; section: string; itemType: string; title: string; status: string; note?: string; taskId?: string }) =>
    call(`/api/focus/reviews/${encodeURIComponent(key)}`, { method: "PUT", json: body }),
  unreview: (key: string) => call(`/api/focus/reviews/${encodeURIComponent(key)}`, { method: "DELETE" }),
  briefJob: () => call<{ jobId: string }>("/api/focus/brief-job", { method: "POST" }),
  runJob: (jobId: string) => call("/api/jobs/run", { method: "POST", json: { jobId, wait: false } }),
};

/** Open a new chat with a drafted message (same event mini-apps use via chat.open). */
export function openChat(message: string): void {
  window.dispatchEvent(new CustomEvent("papr-chat-open", { detail: { message } }));
}
