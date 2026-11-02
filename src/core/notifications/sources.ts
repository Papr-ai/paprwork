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
export interface NoticeTypeDef { id: string; label: string; cat: NoticeCategory }
export interface NoticeSourceDef { id: string; name: string; desc: string; types: NoticeTypeDef[] }

/** Papr Work's own sources, in the order Settings shows them. Apps are added per app (appSourceId). */
export const PAPR_SOURCES: NoticeSourceDef[] = [
  { id: "chats", name: "Chats", desc: "Pen and any other agent you chat with", types: [
    { id: "key.request", label: "Pen needs a key", cat: "needs" },
    { id: "job.permission", label: "Something you set up in a chat is waiting on you", cat: "needs" },
    { id: "chat.done", label: "Finished replies", cat: "done" },
  ] },
  { id: "apps", name: "App management", desc: "Proposals, jobs and publishing for every app you build or install", types: [
    { id: "job.permission", label: "An app's job is waiting on you", cat: "needs" },
    { id: "proposal.review", label: "Proposals to review", cat: "needs" },
    { id: "proposal.result", label: "Your proposal was accepted or declined", cat: "done" },
  ] },
  { id: "account", name: "Account & team", desc: "Billing, your team and the accounts you connected", types: [
    { id: "connection.request", label: "A teammate asked to connect an account", cat: "needs" },
    { id: "connection.update", label: "Connection request updates", cat: "done" },
  ] },
  { id: "updates", name: "App updates", desc: "New versions of Papr Work", types: [
    { id: "app.update_ready", label: "New version ready to install", cat: "needs" },
  ] },
];

const APP_TYPES: NoticeTypeDef[] = [{ id: "app.notification", label: "Notifications from this app", cat: "needs" }];

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
  }
  if (n.source.type === "billing" || n.owner.kind === "account") return "account";
  return n.owner.kind === "chat" ? "chats" : "apps";
}

/** Which chip inside the row. One kind can be two types when its level says which (proposal review vs result). */
export function typeOf(n: NoticeInput): string {
  const done = effectiveLevel(n) === "fyi";
  if (n.kind === "proposal") return done ? "proposal.result" : "proposal.review";
  if (n.kind === "connection") return done ? "connection.update" : "connection.request";
  return n.kind;
}

/** Done or waiting on you comes from the level (FYI is done), so a sender can't make a status update look urgent.
 *  The cat on each type is what Settings shows it under. */
export function categoryOf(n: NoticeInput): NoticeCategory {
  return effectiveLevel(n) === "fyi" ? "done" : "needs";
}
