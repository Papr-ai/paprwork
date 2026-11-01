/**
 * Notices: one table for everything that wants your attention (chat done, approvals,
 * billing, updates). Shared by the gateway store, route() and the UI.
 *
 * Levels (only these four exist):
 *   status   lives where it happens. Never stored as a notice.
 *   fyi      done / good to know: green dot on the thing.
 *   priority needs you soon: amber dot on the thing and its rail icon.
 *   urgent   you're blocked or must act now: red. Only Papr itself may send it.
 */
export type NoticeLevel = "status" | "fyi" | "priority" | "urgent";
export type NoticeSourceType = "platform" | "billing" | "app" | "job" | "agent";
export type NoticeOwnerKind = "chat" | "app" | "account";
export type NoticeMark = "none" | "green" | "amber" | "red";
/** condition = true until fixed; the sender clears it by key. event = happened once; seeing it clears it. */
export type NoticeType = "condition" | "event";

export interface NoticeSource {
  type: NoticeSourceType;
  id: string;
  name: string;
}

/** Every notice belongs to a thing and shows on it: a chat, an app, or a Settings section. */
export interface NoticeOwner {
  kind: NoticeOwnerKind;
  id: string;
  name: string;
  section?: string;
}

export interface NoticeAction {
  label: string;
  /** Named action the platform knows how to run, e.g. "open", "resolve", "chat.open". */
  intent: string;
}

export interface NoticeInput {
  /** Dedupe key: sending the same key updates the row in place and never pings twice. */
  key: string;
  /** Declared type, e.g. "chat.done", "job.permission", "key.request". */
  kind: string;
  type?: NoticeType;
  level: NoticeLevel;
  title: string;
  body?: string;
  source: NoticeSource;
  owner: NoticeOwner;
  /** resolveGroup(x) clears every open notice with this group (e.g. "key:GITHUB_TOKEN"). */
  resolveGroup?: string;
  actions?: NoticeAction[];
}

export interface Notice extends NoticeInput {
  id: string;
  type: NoticeType;
  /** Level after platform caps (apps can't send urgent). */
  mark: NoticeMark;
  /** How many times the same key was sent while open. */
  count: number;
  createdAt: string;
  updatedAt: string;
  seenAt?: string;
  resolvedAt?: string;
  expiresAt?: string;
}

/** Broadcast whenever the open set changes. Carries the full open list (small by design). */
export const NOTICES_CHANGED_EVENT = "notifications:changed";

export const NOTICE_MARK: Record<NoticeLevel, NoticeMark> = {
  status: "none",
  fyi: "green",
  priority: "amber",
  urgent: "red",
};

export const NOTICE_MARK_RANK: Record<NoticeMark, number> = { none: 0, green: 1, amber: 2, red: 3 };

/** Strongest mark wins when a thing has several open notices. */
export function strongestMark(marks: Iterable<NoticeMark>): NoticeMark {
  let best: NoticeMark = "none";
  for (const m of marks) if (NOTICE_MARK_RANK[m] > NOTICE_MARK_RANK[best]) best = m;
  return best;
}
