/**
 * Your notices, the same on every device: the local notices table <-> memory /v1/cloud/notices.
 *
 *  - Pull: GET /v1/cloud/notices?since=<cursor>. The first pull (no cursor) brings everything not done,
 *    silently (no OS pings for old news). Later pulls apply every change, done included, so a notice you
 *    cleared on the laptop clears here too. Runs at boot, every heartbeat and on a notices.changed event.
 *  - Push: seen / later / done / brought back on this device -> POST /v1/cloud/notices/mark (batched).
 *    Marks on notices the server doesn't have (local-only ones) are ignored there.
 * Never throws: signed out, offline or an older server just skips; the next cycle retries.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import type { NoticeMarkChange, RemoteNotice } from "./NoticeService.js";

interface State { v: 1; cursor?: string }
let available = false;

/** The server keeps proposal / connection notices now: local copies from the event feed would double them. */
export function cloudNoticesAvailable(): boolean {
  return available;
}

async function stateFile(): Promise<string> {
  const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
  return path.join(getPaprRoot(), "data", "notices-cloud-sync.json");
}
async function loadState(): Promise<State> {
  try {
    const s = JSON.parse(readFileSync(await stateFile(), "utf8")) as State;
    if (s.v === 1) return s;
  } catch { /* first run */ }
  return { v: 1 };
}
async function saveState(s: State): Promise<void> {
  const f = await stateFile();
  try { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s)); } catch { /* retried */ }
}

export interface PullDeps {
  fetchPage?: (since?: string) => Promise<{ status: number; body?: { notices: RemoteNotice[]; cursor: string; more: boolean } }>;
  apply?: (n: RemoteNotice, silent: boolean) => void;
}

async function defaultFetch(since?: string) {
  const res = await cloudApiFetch(`/v1/cloud/notices${since ? `?since=${encodeURIComponent(since)}` : ""}`, { timeoutMs: 15_000 });
  if (!res.ok) return { status: res.status };
  return { status: res.status, body: (await res.json()) as { notices: RemoteNotice[]; cursor: string; more: boolean } };
}

/** Server notices that replace a desktop one for the same problem (one problem, one notice). */
const REPLACES: Record<string, string> = {
  "billing.credits_out": "account.credits",
  "billing.cloud_paused": "account.plan", "billing.payment_failed": "account.plan",
};

async function defaultApply(n: RemoteNotice, silent: boolean): Promise<void> {
  const { getNoticeService } = await import("./NoticeService.js");
  const svc = getNoticeService();
  svc.applyRemote(n, { silent });
  const local = REPLACES[n.kind];
  if (local && n.state !== "done") svc.resolve(local);
}

/** One pull, all pages. Returns how many notices were applied, or null when skipped. */
export async function pullNotices(deps: PullDeps = {}): Promise<number | null> {
  const state = await loadState();
  const first = !state.cursor;
  let applied = 0;
  for (let page = 0; page < 20; page++) {
    const r = await (deps.fetchPage ?? defaultFetch)(state.cursor);
    if (!r.body) {
      if (r.status === 404 || r.status === 501) available = false;
      return page ? applied : null;
    }
    available = true;
    for (const n of r.body.notices) {
      if (deps.apply) deps.apply(n, first);
      else await defaultApply(n, first);
      applied++;
    }
    state.cursor = r.body.cursor;
    await saveState(state);
    if (!r.body.more) break;
  }
  return applied;
}

// ── push marks ──────────────────────────────────────────────────────────────

const queue = new Map<string, NoticeMarkChange>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Group queued marks by (state, laterUntil): one POST per group. Last mark for a key wins. */
export function batches(changes: NoticeMarkChange[]): NoticeMarkChange[] {
  const last = new Map<string, { state: NoticeMarkChange["state"]; laterUntil?: string }>();
  for (const c of changes) for (const k of c.keys) last.set(k, { state: c.state, laterUntil: c.laterUntil });
  const groups = new Map<string, NoticeMarkChange>();
  for (const [k, v] of last) {
    const g = `${v.state}|${v.laterUntil ?? ""}`;
    const cur = groups.get(g) ?? { keys: [], state: v.state, ...(v.laterUntil ? { laterUntil: v.laterUntil } : {}) };
    cur.keys.push(k);
    groups.set(g, cur);
  }
  return [...groups.values()];
}

async function flush(): Promise<void> {
  const pending = [...queue.values()];
  queue.clear();
  for (const b of batches(pending)) {
    try {
      const res = await cloudApiFetch("/v1/cloud/notices/mark", { method: "POST", body: b, timeoutMs: 15_000 });
      if (res.status >= 500) for (const k of b.keys) queue.set(k, { ...b, keys: [k] }); // retry next time
    } catch {
      for (const k of b.keys) queue.set(k, { ...b, keys: [k] });
    }
  }
}

export function queueMark(m: NoticeMarkChange): void {
  for (const k of m.keys) queue.set(k, { ...m, keys: [k] });
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; void flush(); }, 1500);
}

// ── wiring ──────────────────────────────────────────────────────────────────

let pullTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<unknown> | null = null;

/** Debounced, single-flight. Call at boot, from the heartbeat and on notices.changed. */
export function scheduleNoticePull(reason: string, delayMs = 500): void {
  if (pullTimer) clearTimeout(pullTimer);
  pullTimer = setTimeout(() => {
    pullTimer = null;
    const run = (running ?? Promise.resolve()).then(() => pullNotices())
      .catch((e: Error) => console.warn(`[NoticesCloud] ${reason} skipped: ${e.message.slice(0, 160)}`));
    running = run.finally(() => { if (running === run) running = null; });
  }, delayMs);
}

let wired = false;
export async function startNoticeCloudSync(): Promise<void> {
  if (wired) return;
  wired = true;
  const { onNoticeMarked } = await import("./NoticeService.js");
  onNoticeMarked((m) => queueMark(m));
  scheduleNoticePull("boot", 2000);
}

/** After a workspace switch the next pull starts over for the new workspace. */
export async function resetNoticeCloudSyncForWorkspaceSwitch(): Promise<void> {
  queue.clear();
  available = false;
  await saveState({ v: 1 });
}
