/**
 * Needs you: the one list of what's waiting on you (Focus) and its length (the count on Pen).
 * Shared by the gateway and the UI so both agree on what counts.
 *
 * Things live where they happen. A notice owned by a chat or an app is a dot on that chat or app, and
 * comes into Focus only when promoted (or its source is set to "always"):
 *   No home:  account, billing, connections, updates. Focus is its home, always in.
 *   Owned:    in only when promoted: it has waited over a day. The reason shows on the line.
 *   Urgent:   always in (only Papr sends it).
 *   FYI is never in it; it stays a green dot.
 *   Later:   hidden from the list and the count until laterUntil. The dot stays on the thing.
 *   Muted:   a source muted for an hour leaves the list and the count. Urgent ignores mute.
 * Order: Urgent first, then newest.
 */
import type { Notice } from "../types/notices.js";
import { effectiveLevel } from "./level.js";
import { sourcePref, type NoticePrefs } from "./prefs.js";
import { sourceDef, sourceOf, typeOf } from "./sources.js";

/** How long Mute lasts. */
export const MUTE_MS = 60 * 60 * 1000;
/** Later before noon comes back at 3 PM; after noon, tomorrow at 9 AM. */
const NOON = 12, AFTERNOON = 15, MORNING = 9;

/** When Later brings it back, in local time. */
export function laterUntil(now = new Date()): Date {
  const d = new Date(now);
  if (now.getHours() < NOON) d.setHours(AFTERNOON, 0, 0, 0);
  else { d.setDate(d.getDate() + 1); d.setHours(MORNING, 0, 0, 0); }
  return d;
}

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined });

/** "3 PM today" / "tomorrow 9 AM": what the menu and the Later list say. */
export function whenLabel(until: Date | string, now = new Date()): string {
  const d = typeof until === "string" ? new Date(until) : until;
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? `${clock(d)} today` : days === 1 ? `tomorrow ${clock(d)}` : d.toLocaleDateString(undefined, { weekday: "short", hour: "numeric" });
}

/** "11:40 AM": when a mute set now ends. */
export const muteEndLabel = (until: string) => clock(new Date(until));

export const isUrgent = (n: Notice) => effectiveLevel(n) === "urgent";
const waiting = (n: Notice) => { const l = effectiveLevel(n); return l === "priority" || l === "urgent"; };

/** The source's mute end time if it's muted right now. */
export function mutedUntil(p: NoticePrefs, sourceId: string, now = Date.now()): string | undefined {
  const u = p.sources[sourceId]?.muteUntil;
  return u && Date.parse(u) > now ? u : undefined;
}

/** Sources muted right now, with when each mute ends. */
export function mutedSources(p: NoticePrefs, now = Date.now()): { id: string; until: string }[] {
  return Object.keys(p.sources).flatMap((id) => { const until = mutedUntil(p, id, now); return until ? [{ id, until }] : []; });
}

export const isLater = (n: Notice, now = Date.now()) => !!n.laterUntil && Date.parse(n.laterUntil) > now;

/** Owned notices waiting this long get promoted into Focus. */
export const PROMOTE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Focus is the home of anything not owned by a chat or an app. */
export const hasHome = (n: Notice) => (n.owner.kind === "chat" || n.owner.kind === "app") && n.source.type !== "billing";

/** Why this notice is in Focus, or null if it stays on its dot. Shown on the Focus line. */
export function focusReason(n: Notice, prefs: NoticePrefs, now = Date.now()): string | null {
  if (isUrgent(n) || !hasHome(n)) return "";
  const mode = sourcePref(prefs, sourceOf(n)).focus;
  if (mode === "always") return "";
  if (mode === "never") return null;
  return now - Date.parse(n.createdAt) >= PROMOTE_AFTER_MS ? "Waiting since yesterday" : null;
}

/** The Needs you list. */
export function needsYou(notices: Notice[], prefs: NoticePrefs, now = Date.now()): Notice[] {
  return notices
    .filter((n) => waiting(n) && !isLater(n, now) && (isUrgent(n) || !mutedUntil(prefs, sourceOf(n), now)) && focusReason(n, prefs, now) !== null)
    .sort((a, b) => Number(isUrgent(b)) - Number(isUrgent(a)) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Put off with Later and not back yet, soonest first. */
export function laterList(notices: Notice[], now = Date.now()): Notice[] {
  return notices.filter((n) => waiting(n) && isLater(n, now)).sort((a, b) => a.laterUntil!.localeCompare(b.laterUntil!));
}

/** Names for the … menu: the source row and the type chip this notice obeys in Settings. */
export function noticeLabels(n: Notice): { sourceId: string; source: string; typeId: string; type: string } {
  const sourceId = sourceOf(n), typeId = typeOf(n);
  const def = sourceDef(sourceId, n.source.name);
  return { sourceId, source: def?.name ?? n.source.name, typeId, type: def?.types.find((t) => t.id === typeId)?.chip ?? "these" };
}
