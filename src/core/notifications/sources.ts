/**
 * Notification sources: the rows in Settings → Notifications. Every notice belongs to exactly one
 * source and one type inside it, decided here from facts on the notice (kind, owner, level), never
 * by the sender picking a row. Types are what the chips on a source's page turn on and off.
 *
 *   needs  waiting on you (blue dot)      done  finished / good to know (green dot)
 *   Urgent is never a type: only Papr sends it and it is Always on.
 */
import type { NoticeInput } from "../types/notices.js";
import { effectiveLevel } from "./level.js";

export type NoticeCategory = "needs" | "done";
/** label: the full sentence (tooltip). chip: two or three words for the chip on the source page. */
export interface NoticeTypeDef { id: string; label: string; chip: string; cat: NoticeCategory }
export interface NoticeSourceDef { id: string; name: string; desc: string; types: NoticeTypeDef[] }

/** Papr Work's own sources, in the order Settings shows them. Apps are added per app (appSourceId). */
export const PAPR_SOURCES: NoticeSourceDef[] = [
  { id: "chats", name: "Chats", desc: "Pen and any other agent you chat with", types: [
    { id: "key.request", label: "Pen needs a key", chip: "Key requests", cat: "needs" },
    { id: "job.permission", label: "Something you set up in a chat is waiting on you", chip: "Jobs waiting", cat: "needs" },
    { id: "chat.done", label: "Finished replies", chip: "Finished replies", cat: "done" },
  ] },
  { id: "apps", name: "App management", desc: "Proposals, jobs and publishing for every app you build or install", types: [
    { id: "job.permission", label: "An app's job is waiting on you", chip: "Jobs waiting", cat: "needs" },
    { id: "proposal.review", label: "Proposals to review", chip: "Proposals", cat: "needs" },
    { id: "proposal.result", label: "Your proposal was accepted or declined", chip: "Proposal results", cat: "done" },
  ] },
  { id: "people", name: "People", desc: "Teammates who mention you or ask you to do something", types: [
    { id: "mention", label: "A teammate mentioned you or asked you to do something", chip: "Mentions", cat: "needs" },
    { id: "mention.replied", label: "A teammate answered your mention", chip: "Replies", cat: "done" },
    { id: "mention.due", label: "Something you told a teammate you'd do is due", chip: "Due", cat: "needs" },
    { id: "mention.done", label: "A teammate finished (or can't do) what you asked: your turn", chip: "Your turn", cat: "needs" },
  ] },
  { id: "account", name: "Account & team", desc: "Billing, your team and the accounts you connected", types: [
    { id: "connection.request", label: "A teammate asked to connect an account", chip: "Connect requests", cat: "needs" },
    { id: "member.request", label: "A member asked for credits, a builder seat or a higher limit", chip: "Member requests", cat: "needs" },
    { id: "billing.low", label: "You've used 80% of your credits", chip: "Credits low", cat: "needs" },
    { id: "billing.limit", label: "You hit your member limit or need an admin's approval", chip: "Your limit", cat: "needs" },
    { id: "billing.payment", label: "A plan payment failed, or the plan is set to end", chip: "Payment", cat: "needs" },
    { id: "connection.update", label: "Connection request updates", chip: "Request updates", cat: "done" },
    { id: "member.result", label: "An admin answered your request", chip: "Request answers", cat: "done" },
    { id: "billing.topup_ok", label: "Auto top-up charged the card", chip: "Top-ups", cat: "done" },
    { id: "billing.plan", label: "Plan or seats changed, or the plan ended", chip: "Plan changes", cat: "done" },
  ] },
  { id: "updates", name: "App updates", desc: "New versions of Papr Work", types: [
    { id: "app.update_ready", label: "New version ready to install", chip: "New version", cat: "needs" },
  ] },
];

const APP_TYPES: NoticeTypeDef[] = [{ id: "app.notification", label: "Notifications from this app", chip: "Notifications", cat: "needs" }];

export const appSourceId = (appId: string) => `app:${appId}`;

export function sourceDef(id: string, appName = "App"): NoticeSourceDef | undefined {
  if (id.startsWith("app:")) return { id, name: appName, desc: "Mini-app", types: APP_TYPES };
  return PAPR_SOURCES.find((s) => s.id === id);
}

/** Which row a notice belongs to. Any agent in a chat counts as Chats; a job counts where it reports. */
export function sourceOf(n: NoticeInput): string {
  if (n.source.type === "app") return appSourceId(n.source.id);
  switch (n.kind) {
    case "chat.done": case "key.request": return "chats";
    case "job.permission": return n.owner.kind === "chat" ? "chats" : "apps";
    case "proposal": return "apps";
    case "connection": return "account";
    case "app.update_ready": return "updates";
    case "mention": case "mention.replied": case "mention.done": case "mention.due": return "people";
  }
  if (n.source.type === "billing" || n.owner.kind === "account") return "account";
  return n.owner.kind === "chat" ? "chats" : "apps";
}

/** Server billing kinds -> the chip they obey. Urgent ones (out of credits, top-up failed) are Always on. */
const BILLING_TYPES: Record<string, string> = {
  "member.approved": "member.result", "member.declined": "member.result",
  "billing.member_cap": "billing.limit", "billing.member_approval": "billing.limit",
  "billing.payment_failed": "billing.payment", "billing.cancel_scheduled": "billing.payment",
  "billing.plan_changed": "billing.plan", "billing.ended": "billing.plan",
};

/** Which chip inside the row. One kind can be two types when its level says which (proposal review vs result). */
export function typeOf(n: NoticeInput): string {
  const done = effectiveLevel(n) === "fyi";
  // Desktop sends "proposal" / "connection"; the server sends proposal.received, connection.requested, ...
  if (n.kind === "proposal" || n.kind.startsWith("proposal.")) return done ? "proposal.result" : "proposal.review";
  if (n.kind === "connection" || n.kind.startsWith("connection.")) return done ? "connection.update" : "connection.request";
  return BILLING_TYPES[n.kind] ?? (n.kind.startsWith("member.request.") ? "member.request" : n.kind);
}

/** Done or waiting on you comes from the level (FYI is done), so a sender can't make a status update look urgent.
 *  The cat on each type is what Settings shows it under. */
export function categoryOf(n: NoticeInput): NoticeCategory {
  return effectiveLevel(n) === "fyi" ? "done" : "needs";
}
