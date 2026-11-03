/**
 * route(): one pure function decides where a notice shows. Same rules as the Notifications UX
 * prototype. Two steps:
 *   1. Facts: the sender's level (capped), whether Paprwork is in front, Do Not Disturb, whether
 *      you're looking at the thing, and whether it's already showing.
 *   2. Your settings for its source and type (prefs.ts). They only take things away.
 * Urgent is Papr-only and Always on: settings never touch it.
 */
import { NOTICE_MARK, type NoticeInput, type NoticeLevel, type NoticeMark } from "../types/notices.js";
import { effectiveLevel } from "./level.js";
import { sourcePref, typeOn, type NoticePrefs } from "./prefs.js";
import { categoryOf, sourceDef, sourceOf, typeOf } from "./sources.js";

export { effectiveLevel } from "./level.js";
export { DEFAULT_NOTICE_PREFS, type NoticePrefs } from "./prefs.js";

export interface RouteCtx {
  prefs: NoticePrefs;
  /** Paprwork window focused. */
  foreground: boolean;
  /** Do Not Disturb: paused in Settings → Notifications. (macOS Focus is applied by macOS itself.) */
  dnd: boolean;
  /** You're looking at the owner right now. */
  viewingOwner: boolean;
  /** Same key already open. */
  existing?: { count: number };
  /** For tests; defaults to Date.now(). */
  now?: number;
}

export interface Delivery {
  level: NoticeLevel;
  mark: NoticeMark;
  /** Pen leans out with one fix. Urgent only. */
  lean: boolean;
  os: boolean;
  /** Desktop notification plays a sound: waiting on you (unless the source's Sound is off) and Urgent. Done is quiet. */
  sound: boolean;
  email: "none" | "now" | "digest";
  coalesced: boolean;
  /** Your settings turned it off (counted, so we can see what people mute). */
  muted: boolean;
  /** Do Not Disturb held back its desktop notification. */
  paused: boolean;
  /** Settings row and chip it obeyed, e.g. "chats" / "chat.done". */
  source: string;
  type: string;
  why: string[];
}

export interface RoutedNotice extends NoticeInput {
  /** App-sent: the app's own notification.show call (a mention, assigned to you, due). Without it an app notice stays inside the app. */
  forYou?: boolean;
  /** About the whole app (offline): Pen's icon and Focus's top line, no dot. */
  ambient?: boolean;
}

/** Kinds that live in Focus only: Pen asking about a goal should never interrupt you. */
const FOCUS_ONLY = new Set(["focus.checkin"]);

export function route(n: RoutedNotice, c: RouteCtx): Delivery {
  const capped = effectiveLevel(n);
  const source = sourceOf(n), type = typeOf(n);
  const why: string[] = capped !== n.level ? [`${n.source.name} can't send Urgent: treated as Priority`] : [];
  const d: Delivery = { level: capped, mark: NOTICE_MARK[capped], lean: false, os: false, sound: false, email: "none", coalesced: false, muted: false, paused: false, source, type, why };
  if (n.ambient) {
    d.mark = "none";
    why.push("about the whole app: Pen's icon and Focus's top line, no dot, no desktop notification");
    return d;
  }
  if (capped === "status") { why.push(`shown only inside ${n.owner.name}`); return d; }
  if (n.source.type === "app" && !n.forYou) {
    return { ...d, level: "status", mark: "none", why: [...why, `not addressed to you: kept inside ${n.source.name}`] };
  }
  if (capped === "urgent") { urgent(d, n, c); return dedupe(d, c); }
  const def = sourceDef(source, n.source.name), name = def?.name ?? n.source.name;
  const p = sourcePref(c.prefs, source), cat = categoryOf(n);
  if (!p.allow || !typeOn(c.prefs, source, type)) {
    return { ...d, level: "status", mark: "none", muted: true, why: [...why, `you turned this off in ${name}: shown only inside ${n.owner.name}`] };
  }
  if (c.viewingOwner && c.foreground) {
    if (cat === "done") d.mark = "none";
    why.push("you're looking at it: shown in place");
    return dedupe(d, c);
  }
  why.push(cat === "needs" ? "blue dot until it's handled" : "green dot until you look");
  if (!p[cat].badge) { d.mark = "none"; why.push(`${name} › Badges is off: no dot`); }
  if (c.foreground) why.push("Paprwork is in front: nothing pops");
  else if (p.muteUntil && Date.parse(p.muteUntil) > (c.now ?? Date.now())) { d.paused = p[cat].desktop; why.push(`${name} is muted for an hour: kept as a dot, no desktop notification`); }
  else if (c.dnd) { d.paused = p[cat].desktop && !FOCUS_ONLY.has(n.kind); why.push("Do Not Disturb is on: kept as a dot, no desktop notification"); }
  else if (FOCUS_ONLY.has(n.kind)) why.push("check-ins stay in Focus: never a desktop notification");
  else if (!p[cat].desktop) why.push(`${name} › Desktop is off: no desktop notification`);
  else {
    d.os = true;
    d.sound = cat === "needs" && p.sound;
    why.push(cat === "needs" && !p.sound ? `Paprwork in background: desktop notification, no sound (${name} › Sound is off)` : "Paprwork in background: desktop notification");
  }
  return dedupe(d, c);
}

function urgent(d: Delivery, n: NoticeInput, c: RouteCtx): void {
  d.lean = true;
  d.why.push("Always on: blue dot and Pen leans out with one fix until it's fixed");
  if (!c.foreground) {
    d.os = true;
    d.sound = true;
    if (n.source.type === "billing") d.email = "now";
    d.why.push("Paprwork not in front: desktop notification");
  }
  if (c.dnd) d.why.push("breaks through Do Not Disturb");
}

/** Same key already open: update in place, never ping twice. */
function dedupe(d: Delivery, c: RouteCtx): Delivery {
  if (!c.existing) return d;
  return { ...d, coalesced: true, os: false, sound: false, email: "none",
    why: [...d.why, `already showing (x${c.existing.count}): updated in place, no second ping`] };
}
