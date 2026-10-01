/**
 * Cross-machine proposal status feed.
 *
 * The owner and a contributor are usually on different desktops, so local
 * broadcasts never reach the other side. The memory server logs every status
 * change that matters to the other person (received / accepted / declined /
 * needs update); each heartbeat reads new events after a cursor, refreshes
 * the affected share bars + inbox, and asks the renderer for an OS
 * notification.
 */

import { promises as fs } from "fs";
import path from "path";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { broadcast } from "../../websocket/index.js";
import { notifyCloudSyncItemsStale } from "./cloudSyncBroadcast.js";

export type ProposalEventType =
  | "proposal.received"
  | "proposal.accepted"
  | "proposal.declined"
  | "proposal.needs_update";

export interface ProposalEvent {
  id: string;
  seq: number;
  type: ProposalEventType | string;
  role: "owner" | "contributor" | string;
  requestId?: string | null;
  sourceAppId?: string | null;
  sourceSlug?: string | null;
  installedAppId?: string | null;
  title?: string | null;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface ProposalNotice {
  title: string;
  body: string;
  /** App whose share bar / inbox this is about, on this machine. */
  appId?: string;
  requestId?: string;
}

/** Local app ids to refresh: the owner's source app or the contributor's copy. */
export function appIdsToRefresh(events: ProposalEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    const id = e.role === "owner" ? e.sourceAppId : e.installedAppId;
    if (id) ids.add(id);
  }
  return [...ids];
}

function quoted(title?: string | null): string {
  const t = title?.trim();
  return t ? `“${t.length > 60 ? `${t.slice(0, 57)}…` : t}”` : "your proposal";
}

/** Plain-language notice, or null for events not worth interrupting for. */
export function noticeForEvent(e: ProposalEvent): ProposalNotice | null {
  const app = e.sourceSlug ? ` (${e.sourceSlug})` : "";
  const appId =
    (e.role === "owner" ? e.sourceAppId : e.installedAppId) ?? undefined;
  const requestId = e.requestId ?? undefined;
  if (e.role === "contributor") {
    switch (e.type) {
      case "proposal.accepted":
        return {
          title: "Proposal accepted",
          body: `${quoted(e.title)} is now in the app${app}.`,
          appId,
          requestId,
        };
      case "proposal.declined":
        return {
          title: "Proposal declined",
          body: `${quoted(e.title)} was declined. Your copy is unchanged.`,
          appId,
          requestId,
        };
      case "proposal.needs_update":
        return {
          title: "Proposal needs an update",
          body: `The app${app} changed since you sent ${quoted(e.title)}. Open it and choose Update & re-propose.`,
          appId,
          requestId,
        };
    }
    return null;
  }
  if (e.role === "owner" && e.type === "proposal.received") {
    return {
      title: "New proposal",
      body: `${quoted(e.title)} was proposed for your app${app}.`,
      appId,
      requestId,
    };
  }
  // Owner-side "needs update" only refreshes the inbox; the contributor acts.
  return null;
}

/** Collapse a burst (e.g. first poll after sleep) into at most `max` notices. */
export function summarizeNotices(
  events: ProposalEvent[],
  max = 3,
): ProposalNotice[] {
  const latestByRequest = new Map<string, ProposalEvent>();
  for (const e of events) {
    latestByRequest.set(`${e.role}:${e.requestId ?? e.id}`, e);
  }
  const notices = [...latestByRequest.values()]
    .map(noticeForEvent)
    .filter((n): n is ProposalNotice => n !== null);
  if (notices.length <= max) return notices;
  return [
    ...notices.slice(0, max - 1),
    {
      title: "Proposal updates",
      body: `${notices.length - (max - 1)} more proposal updates — open Paprwork to review.`,
    },
  ];
}

// ── Cursor persistence ──────────────────────────────────────────────────────

const CURSOR_FILE = path.join("data", "cloud-proposal-events-cursor.json");

type CursorFile = Record<string, string>;

async function readCursors(paprDir: string): Promise<CursorFile> {
  try {
    const raw = await fs.readFile(path.join(paprDir, CURSOR_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CursorFile) : {};
  } catch {
    return {};
  }
}

async function writeCursor(
  paprDir: string,
  userKey: string,
  cursor: string,
): Promise<void> {
  const all = await readCursors(paprDir);
  all[userKey] = cursor;
  const target = path.join(paprDir, CURSOR_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

// ── Poll ────────────────────────────────────────────────────────────────────

export interface PollDeps {
  fetchEvents?: (
    since: string | undefined,
  ) => Promise<{ events: ProposalEvent[]; cursor: string } | null>;
  onRefresh?: (appIds: string[]) => void;
  onNotify?: (notices: ProposalNotice[]) => void;
}

async function defaultFetchEvents(
  since: string | undefined,
): Promise<{ events: ProposalEvent[]; cursor: string } | null> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  const res = await cloudApiFetch(`/v1/cloud/apps/changes/events${qs}`, {
    timeoutMs: 15_000,
  });
  if (res.status === 404) return null; // server not deployed yet
  if (!res.ok) throw new Error(`events ${res.status}`);
  return (await res.json()) as { events: ProposalEvent[]; cursor: string };
}

function defaultRefresh(appIds: string[]): void {
  for (const id of appIds) notifyCloudSyncItemsStale(id);
  broadcast({ type: "cloud-change-requests:stale", data: {} });
}

function defaultNotify(notices: ProposalNotice[]): void {
  if (notices.length === 0) return;
  broadcast({ type: "cloud-proposal:notify", data: { notices } });
}

let inFlight = false;

/**
 * One poll. Returns how many events were applied. Safe to call every
 * heartbeat: single-flight, and never throws.
 */
export async function pollProposalEvents(
  paprDir: string,
  userKey: string,
  deps: PollDeps = {},
): Promise<number> {
  if (inFlight) return 0;
  inFlight = true;
  try {
    const since = (await readCursors(paprDir))[userKey];
    const page = await (deps.fetchEvents ?? defaultFetchEvents)(since);
    if (!page) return 0;
    if (page.events.length > 0) {
      (deps.onRefresh ?? defaultRefresh)(appIdsToRefresh(page.events));
      (deps.onNotify ?? defaultNotify)(summarizeNotices(page.events));
    }
    if (page.cursor && page.cursor !== since) {
      await writeCursor(paprDir, userKey, page.cursor);
    }
    return page.events.length;
  } catch (err) {
    console.warn(
      "[CloudSync] Proposal events poll failed:",
      (err as Error).message.slice(0, 120),
    );
    return 0;
  } finally {
    inFlight = false;
  }
}
