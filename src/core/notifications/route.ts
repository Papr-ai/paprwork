/**
 * route(): one pure function decides where a notice shows. Ported from the
 * Notifications UX prototype (same rules, same tests). No Pen in here: Pen
 * organises Focus after delivery is decided, it never changes delivery.
 */
import {
  NOTICE_MARK,
  type NoticeInput,
  type NoticeLevel,
  type NoticeMark,
} from "../types/notices.js";

export type AppPref = "all" | "mentions" | "off";

export interface NoticePrefs {
  priorityOs: boolean;
  priorityEmail: boolean;
  chatDoneOs: boolean;
  apps?: Record<string, AppPref>;
}

export interface RouteCtx {
  prefs: NoticePrefs;
  /** Paprwork window focused. */
  foreground: boolean;
  /** OS focus mode / quiet hours (macOS only today; false elsewhere). */
  dnd: boolean;
  /** You're looking at the owner right now. */
  viewingOwner: boolean;
  /** Same key already open. */
  existing?: { count: number };
}

export interface Delivery {
  level: NoticeLevel;
  mark: NoticeMark;
  /** Pen leans out with one fix. Urgent only. */
  lean: boolean;
  os: boolean;
  email: "none" | "now" | "digest";
  coalesced: boolean;
  why: string[];
}

export interface RoutedNotice extends NoticeInput {
  /** App-sent: a mention, assigned to you, or due. Passes the "For me" setting. */
  forYou?: boolean;
  /** About the whole app (offline): Pen's icon and Focus's top line, no dot. */
  ambient?: boolean;
}

export const DEFAULT_NOTICE_PREFS: NoticePrefs = {
  priorityOs: true,
  priorityEmail: false,
  chatDoneOs: true,
};

/** Only Papr itself (platform, billing) may say Urgent. Apps, jobs and agents top out at Priority. */
export function effectiveLevel(n: NoticeInput): NoticeLevel {
  const trusted = n.source.type === "platform" || n.source.type === "billing";
  return n.level === "urgent" && !trusted ? "priority" : n.level;
}

/** App-sent notices pass the per-app setting. Default "For me": mentions, assigned, due. */
function appFilter(n: RoutedNotice, level: NoticeLevel, c: RouteCtx, why: string[]): NoticeLevel {
  if (n.source.type !== "app") return level;
  const p = c.prefs.apps?.[n.source.id] ?? "mentions";
  if (p === "off") {
    why.push(`${n.source.name} is off: kept inside the app`);
    return "status";
  }
  if (p === "mentions" && !n.forYou) {
    why.push(`${n.source.name} is set to For me and this isn't for you: kept inside the app`);
    return "status";
  }
  return level;
}

export function route(n: RoutedNotice, c: RouteCtx): Delivery {
  const capped = effectiveLevel(n);
  const why: string[] = capped !== n.level ? [`${n.source.name} can't send Urgent: treated as Priority`] : [];
  const level = appFilter(n, capped, c, why);
  const d: Delivery = { level, mark: NOTICE_MARK[level], lean: false, os: false, email: "none", coalesced: false, why };
  if (n.ambient) {
    d.mark = "none";
    d.why.push("about the whole app: Pen's icon and Focus's top line, no dot, no OS");
    return d;
  }
  if (level === "status") d.why.push(`shown only inside ${n.owner.name}`);
  else if (level === "urgent") urgent(d, n, c);
  else if (level === "priority") priority(d, c);
  else fyi(d, n, c);
  return dedupe(d, c);
}

function urgent(d: Delivery, n: NoticeInput, c: RouteCtx): void {
  d.lean = true;
  d.why.push("red dot; Pen leans out with one fix until it's fixed");
  if (!c.foreground) {
    d.os = true;
    if (n.source.type === "billing") d.email = "now";
    d.why.push("Paprwork not in front: OS notification");
  }
  if (c.dnd) d.why.push("breaks through Do Not Disturb");
}

function priority(d: Delivery, c: RouteCtx): void {
  d.why.push("amber dot until it's handled");
  if (c.viewingOwner && c.foreground) {
    d.why.push("you're looking at it: shown in place");
    return;
  }
  if (c.prefs.priorityEmail) d.email = "digest";
  if (c.dnd) {
    d.why.push("Do Not Disturb: nothing pops");
    return;
  }
  if (!c.foreground && c.prefs.priorityOs) {
    d.os = true;
    d.why.push("Paprwork in background: OS notification");
  }
}

function fyi(d: Delivery, n: NoticeInput, c: RouteCtx): void {
  if (c.viewingOwner && c.foreground) {
    d.mark = "none";
    d.why.push("you're looking at it: nothing to add");
    return;
  }
  d.why.push("green dot. Nothing pops.");
  if (n.owner.kind === "chat" && !c.foreground && !c.dnd && c.prefs.chatDoneOs) {
    d.os = true;
    d.why.push("chat finished while you're away: OS notification");
  }
}

/** Same key already open: update in place, never ping twice. */
function dedupe(d: Delivery, c: RouteCtx): Delivery {
  if (!c.existing) return d;
  return {
    ...d,
    coalesced: true,
    os: false,
    email: "none",
    why: [...d.why, `already showing (x${c.existing.count}): updated in place, no second ping`],
  };
}
