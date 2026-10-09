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
  | "proposal.needs_update"
  /** A Maintainer/Admin merged into your app (accepted or published directly). */
  | "proposal.merged"
  | "connection.requested"
  | "connection.approved"
  | "connection.declined";

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
  /** Connections notices open Settings → Connections (org requests for admins). */
  openSettings?: "connections" | "connections-requests";
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

/** Org connection requests ride the same feed (memory server connection_policy_service). */
function connectionNotice(e: ProposalEvent): ProposalNotice | null {
  const name = e.title?.trim() || String(e.detail?.serverId ?? "a service");
  const reason = typeof e.detail?.reason === "string" && e.detail.reason ? ` "${e.detail.reason}"` : "";
  switch (e.type) {
    case "connection.requested":
      return { title: `${name} requested`, body: `A teammate asked to connect ${name}. Review it in Connections.`, openSettings: "connections-requests" };
    case "connection.approved":
      return { title: `${name} approved`, body: `You can connect ${name} now.`, openSettings: "connections" };
    case "connection.declined":
      return { title: `${name} not approved`, body: `Your admin declined ${name}.${reason}`, openSettings: "connections" };
  }
  return null;
}

/** Plain-language notice, or null for events not worth interrupting for. */
export function noticeForEvent(e: ProposalEvent): ProposalNotice | null {
  if (e.type.startsWith("connection.")) return connectionNotice(e);
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
  if (e.role === "owner" && e.type === "proposal.merged") {
    const direct = e.detail?.publishedDirectly === true;
    return {
      title: direct ? "Changes published to your app" : "Proposal accepted by a Maintainer",
      body: `${quoted(e.title)} is now live${app}. Your Mac is getting the new version.`,
      appId,
      requestId,
    };
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

/** Publisher-side apps a Maintainer/Admin merged into: pull them. */
export function mergedSourceAppIds(events: ProposalEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.role === "owner" && e.type === "proposal.merged" && e.sourceAppId) ids.add(e.sourceAppId);
  }
  return [...ids];
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
  /** Pull apps someone else merged into (publisher side). */
  onMerged?: (sourceAppIds: string[]) => void;
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

/** Connections UI (requests list, badge, Request button state) refreshes on this. */
function refreshConnections(events: ProposalEvent[]): void {
  if (events.some((e) => e.type.startsWith("connection."))) {
    broadcast({ type: "mcp-org:stale", data: {} });
  }
}

function defaultNotify(notices: ProposalNotice[]): void {
  if (notices.length === 0) return;
  broadcast({ type: "cloud-proposal:notify", data: { notices } });
}

/**
 * Same follow-up as accepting a proposal yourself: pull the merged code (held
 * if it overlaps unpublished local edits, so the chip says Updates on web),
 * then rebuild outputs. Skips apps that aren't on this machine.
 */
function defaultMerged(sourceAppIds: string[]): void {
  for (const id of sourceAppIds) {
    void (async () => {
      const { getPaprAppsRoot } = await import("../../../core/utils/paprRoot.js");
      try {
        await fs.access(path.join(getPaprAppsRoot(), id));
      } catch {
        return;
      }
      const { followUpContributeApprove } = await import("../contributeApproveFollowUp.js");
      await followUpContributeApprove(id);
    })().catch((err: Error) => {
      console.warn(`[CloudSync] Pull after Maintainer merge failed for ${id}:`, err.message.slice(0, 120));
    });
  }
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
      if (!deps.onRefresh) refreshConnections(page.events);
      (deps.onNotify ?? defaultNotify)(summarizeNotices(page.events));
      const merged = mergedSourceAppIds(page.events);
      if (merged.length > 0) (deps.onMerged ?? defaultMerged)(merged);
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
