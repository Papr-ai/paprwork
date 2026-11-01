/**
 * Where today's signals raise and clear notices. Each sender owns its keys:
 *   chat.done:{chatId}       FYI event when a reply finishes; seeing the chat clears it.
 *   job.permission:{jobId}   Priority condition while a job waits for a key or schedule OK.
 *   key.request:{chatId}:{name} Priority condition while Pen waits for a key you haven't added.
 * Everything here is best-effort: a notice failing must never break the turn or the job.
 */
import type { JobRecord } from "../jobs/types.js";
import { tryNotify, tryResolve, tryResolveGroup, getNoticeService } from "./NoticeService.js";

const pen = { type: "agent" as const, id: "pen", name: "Pen" };

async function chatTitle(chatId: string): Promise<string> {
  try {
    const { getStorageManager } = await import("../StorageManager.js");
    const chat = await getStorageManager().getChat(chatId);
    return chat?.title?.trim() || "Chat";
  } catch {
    return "Chat";
  }
}

/** A reply finished. Skipped automatically when you're looking at that chat (NoticeService). */
export async function noticeChatDone(chatId: string): Promise<void> {
  // Only chats you see in the tab bar: job runs and delegation mini-chats report elsewhere.
  if (!chatId || /^(temp-|job:|delegation:)/.test(chatId)) return;
  const name = await chatTitle(chatId);
  tryNotify({
    key: `chat.done:${chatId}`, kind: "chat.done", type: "event", level: "fyi",
    title: `Reply ready in ${name}`, source: pen, owner: { kind: "chat", id: chatId, name },
    actions: [{ label: "Open", intent: "open" }],
  });
}

/** The chat is gone: nothing about it should keep a dot. */
export function noticeChatDeleted(chatId: string): void {
  try {
    const svc = getNoticeService();
    for (const n of svc.listOpen()) if (n.owner.kind === "chat" && n.owner.id === chatId) svc.resolve(n.key);
  } catch (e) {
    console.warn("[noticeSources] chat cleanup failed:", e);
  }
}

/** Mirrors job status: waiting_permission raises, anything else clears. */
export function syncJobPermissionNotice(job: Pick<JobRecord, "id" | "name" | "status" | "reportChatId"
  | "waitingPermissionKeys" | "waitingScheduleRisk">): void {
  const key = `job.permission:${job.id}`;
  const keys = job.waitingPermissionKeys ?? [];
  if (job.status !== "waiting_permission" || (!keys.length && !job.waitingScheduleRisk)) {
    tryResolve(key);
    return;
  }
  const what = keys.length ? `needs ${keys.join(", ")}` : "needs you to approve its schedule";
  const owner = job.reportChatId
    ? { kind: "chat" as const, id: job.reportChatId, name: job.name }
    : { kind: "app" as const, id: `job:${job.id}`, name: job.name };
  tryNotify({
    key, kind: "job.permission", type: "condition", level: "priority",
    title: `${job.name} ${what}`, body: "The job is paused until you answer.",
    source: { type: "job", id: job.id, name: job.name }, owner,
    actions: [{ label: "Review", intent: "open" }],
  });
}

/** Pen asked for a key in a chat (request_key tool). */
export async function noticeKeyRequested(chatId: string | null, name: string, description?: string): Promise<void> {
  if (!chatId) return;
  const title = await chatTitle(chatId);
  tryNotify({
    key: `key.request:${chatId}:${name}`, kind: "key.request", type: "condition", level: "priority",
    title: `Pen needs ${name}`, ...(description ? { body: description } : {}),
    source: pen, owner: { kind: "chat", id: chatId, name: title }, resolveGroup: `key:${name}`,
    actions: [{ label: "Add key", intent: "open" }],
  });
}

/** The key now exists (added from the card, Settings or the vault): every request for it is answered. */
export function noticeKeyAdded(name: string | undefined): void {
  if (name) tryResolveGroup(`key:${name}`);
}
