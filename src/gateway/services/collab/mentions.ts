/**
 * Mentions between people (memory server /v1/cloud/collab/mentions).
 *
 *   Send:    you @-mention a teammate, or Pen tags one (mention_person): recorded quietly.
 *   Notify:  you or Pen tell them when it matters (notify_people → /mentions/notify).
 *   Suggest: an @ is context for Pen. When Pen thinks someone should do something it tags them quietly
 *            with the ask; the sender's chat shows "Ask Shawkat?" and nothing is sent until they say yes.
 *   Receive: the heartbeat event feed brings `mention`; it lands in Focus (Needs you) as the sender's ask
 *            with Pen's drafted reply: Take it and reply, Can't, Later. A chat holds it for Pen's help.
 *   Track:   the sender's Focus lists open asks under "Waiting on" (Asked, Took it, Done).
 *   Back:    `mention.replied` posts in the chat it came from. Done or can't = "Your turn" in Focus.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { broadcast } from "../../websocket/index.js";
import { tryNotify, tryResolve } from "../notifications/NoticeService.js";
import type { StoredMessage } from "../storage/IStorageProvider.js";

export interface MentionAction { title: string; due?: string | null }
export interface MentionContext { chatId?: string; chatTitle?: string; appId?: string; appName?: string; goalId?: string }
export interface MentionItem {
  id: string; fromUserId: string; fromName: string; toUserId: string; toName: string; text: string;
  context: MentionContext; action: MentionAction | null; status: "open" | "done" | "dismissed";
  reply: { text: string; at: string } | null; createdAt: string; notified?: boolean;
}
/** What the chat card renders. Stored as the result of a `mention_inbox` tool call on the message. */
export interface MentionCardData {
  type: "mention_inbox"; itemId: string; fromName: string; text: string; context: MentionContext;
  action: MentionAction | null; suggestedReply: string; nextStep?: string;
  status: "open" | "done" | "dismissed"; sentReply?: string;
}
export interface CollabEvent {
  id: string; type: string; requestId?: string | null; actorUserId?: string | null;
  title?: string | null; detail?: Record<string, unknown>; createdAt: string;
}

export const MENTION_TOOL = "mention_inbox";
export const isCollabEvent = (e: { type: string }) => e.type === "mention" || e.type === "mention.replied";
export const mentionNoticeKey = (itemId: string) => `mention:${itemId}`;

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await cloudApiFetch(`/v1/cloud/collab${path}`, { method, body, timeoutMs: 20_000 });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try { detail = (JSON.parse(text) as { detail?: string }).detail ?? detail; } catch { /* not JSON */ }
    throw new Error(res.status === 404 && !text.includes("detail") ? "Mentions aren't available on this server yet" : detail);
  }
  return JSON.parse(text) as T;
}

async function chatTitle(chatId?: string): Promise<string | undefined> {
  if (!chatId) return undefined;
  const { getStorageManager } = await import("../StorageManager.js");
  return (await getStorageManager().getChat(chatId).catch(() => null))?.title || undefined;
}

/** Record a mention. Quiet unless notify: the person isn't told until notifyMentions (or notify: true). */
export async function sendMention(input: {
  toUserIds: string[]; text: string; chatId?: string; action?: MentionAction | null; context?: MentionContext; notify?: boolean;
}): Promise<MentionItem[]> {
  const context: MentionContext = { ...input.context };
  if (input.chatId) { context.chatId = input.chatId; context.chatTitle ??= await chatTitle(input.chatId); }
  const out = await call<{ mentions: MentionItem[] }>("/mentions", "POST", {
    toUserIds: input.toUserIds, text: input.text, context, action: input.action ?? undefined, notify: !!input.notify,
  });
  return out.mentions;
}

/** Tell the people on mentions the user sent. A note replaces the message they'll see. */
export const notifyMentions = (ids: string[], note?: string) =>
  call<{ mentions: MentionItem[] }>("/mentions/notify", "POST", { ids, note }).then((r) => r.mentions);

export const listMembers = () =>
  call<{ members: Array<{ userId: string; displayName: string; email: string }> }>("/members").then((r) => r.members);

export const getMention = (id: string) => call<{ mention: MentionItem }>(`/mentions/${encodeURIComponent(id)}`).then((r) => r.mention);
export const listMentions = (box: "inbox" | "sent" = "inbox", status: string | null = "open") =>
  call<{ mentions: MentionItem[] }>(`/mentions?box=${box}${status ? `&status=${status}` : "&status="}`).then((r) => r.mentions);

/** Answer a mention: send the reply (optional) and close it. Updates the card and clears the notice. */
export async function answerMention(itemId: string, status: "open" | "done" | "dismissed", reply?: string): Promise<MentionItem> {
  const out = await call<{ mention: MentionItem }>(`/mentions/${encodeURIComponent(itemId)}/resolve`, "POST", { status, reply });
  // "Take it and reply" keeps it open: it stays on Focus as your task until you mark it done.
  if (status !== "open") tryResolve(mentionNoticeKey(itemId));
  await updateCard(itemId, { status: out.mention.status, ...(reply ? { sentReply: reply } : {}) });
  return out.mention;
}

// ── Pen's suggestion ──────────────────────────────────────────────────────────

export function parseSuggestion(raw: string | null): { reply: string; nextStep?: string } | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : raw) as { reply?: unknown; nextStep?: unknown };
    if (typeof j.reply !== "string" || !j.reply.trim()) return null;
    return { reply: j.reply.trim(), ...(typeof j.nextStep === "string" && j.nextStep.trim() ? { nextStep: j.nextStep.trim() } : {}) };
  } catch {
    return raw.trim() ? { reply: raw.trim().slice(0, 600) } : null;
  }
}

async function suggest(item: MentionItem): Promise<{ reply: string; nextStep?: string }> {
  const fallback = { reply: item.action ? `On it. I'll ${lowerFirst(item.action.title)}${item.action.due ? ` by ${item.action.due}` : ""}.` : "Thanks, got it." };
  try {
    const { generateSimpleText } = await import("../../utils/simpleTextGeneration.js");
    const raw = await generateSimpleText(
      "You are Pen, a teammate's work assistant. Someone mentioned your user. Draft the short reply your user would send back " +
        "(first person, plain, friendly, at most 2 sentences, no greeting fluff) and the one next step they should take. " +
        'Answer only JSON: {"reply": "...", "nextStep": "..."}',
      [
        `${item.fromName} wrote to ${item.toName}${item.context.chatTitle ? ` (from the chat "${item.context.chatTitle}")` : ""}:`,
        item.text,
        item.action ? `Action asked of ${item.toName}: ${item.action.title}${item.action.due ? ` (due ${item.action.due})` : ""}` : "",
      ].filter(Boolean).join("\n"),
      300,
      "[Mentions]",
    );
    return parseSuggestion(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// ── Incoming events ───────────────────────────────────────────────────────────

export function mentionMessageText(c: MentionCardData): string {
  const where = c.context.chatTitle ? ` in “${c.context.chatTitle}”` : "";
  return [
    `**${c.fromName} mentioned you${where}**`,
    `> ${c.text.split("\n").join("\n> ")}`,
    c.action ? `**For you:** ${c.action.title}${c.action.due ? ` (due ${c.action.due})` : ""}` : "",
    `**Suggested reply:** ${c.suggestedReply}`,
    c.nextStep ? `**Next step:** ${c.nextStep}` : "",
    `_Mention id: ${c.itemId}. To answer it, use answer_mention._`,
  ].filter(Boolean).join("\n\n");
}

function cardMessage(chatId: string, card: MentionCardData): StoredMessage {
  return {
    id: `msg-${uuidv4()}`, chat_id: chatId, role: "assistant", content: mentionMessageText(card),
    timestamp: new Date().toISOString(), sync_status: "local",
    toolCalls: [{ id: `mention-${card.itemId}`, name: MENTION_TOOL, args: { itemId: card.itemId }, result: JSON.stringify(card), status: "success" }],
  };
}

/** Item id → chat id + message id of its card, so answering updates the card in place (survives restarts). */
type CardRef = { chatId: string; messageId: string; card: MentionCardData };
let cardsCache: Map<string, CardRef> | null = null;

async function cardsFile(): Promise<string> {
  const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
  return path.join(getPaprRoot(), "data", "mention-cards.json");
}

async function cards(): Promise<Map<string, CardRef>> {
  if (cardsCache) return cardsCache;
  try { cardsCache = new Map(Object.entries(JSON.parse(readFileSync(await cardsFile(), "utf8")) as Record<string, CardRef>)); }
  catch { cardsCache = new Map(); }
  return cardsCache;
}

async function saveCards(): Promise<void> {
  const file = await cardsFile();
  const entries = [...(await cards()).entries()].slice(-500);
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(Object.fromEntries(entries))); }
  catch (e) { console.warn("[Mentions] could not save cards:", (e as Error).message); }
}

/** The Focus card's data for a mention that arrived here (the ask, the action, Pen's draft, what you sent). */
export async function mentionCard(itemId: string): Promise<(MentionCardData & { chatId: string }) | null> {
  const hit = (await cards()).get(itemId);
  return hit ? { ...hit.card, chatId: hit.chatId } : null;
}

/** The sender's open asks that were sent, for "Waiting on" in Focus. */
export async function waitingOn(): Promise<MentionItem[]> {
  return (await listMentions("sent", "open")).filter((m) => m.notified !== false);
}

/** The chat a mention's card lives in, if it arrived on this machine. */
export async function mentionChatId(itemId: string): Promise<string | undefined> {
  return (await cards()).get(itemId)?.chatId;
}

async function updateCard(itemId: string, patch: Partial<MentionCardData>): Promise<void> {
  const hit = (await cards()).get(itemId);
  if (!hit) return;
  hit.card = { ...hit.card, ...patch };
  await saveCards();
  const { getStorageManager } = await import("../StorageManager.js");
  const msg = { ...cardMessage(hit.chatId, hit.card), id: hit.messageId };
  await getStorageManager().updateMessage(hit.chatId, hit.messageId, msg).catch(() => undefined);
  broadcast({ type: "collab:card", data: { itemId, card: hit.card } });
}

async function receiveMention(e: CollabEvent): Promise<void> {
  const itemId = e.requestId;
  if (!itemId) return;
  const item = await getMention(itemId).catch(() => null);
  if (!item || item.status !== "open" || (await cards()).has(itemId)) return;
  const s = await suggest(item);
  const card: MentionCardData = {
    type: "mention_inbox", itemId, fromName: item.fromName, text: item.text, context: item.context ?? {},
    action: item.action, suggestedReply: s.reply, ...(s.nextStep ? { nextStep: s.nextStep } : {}), status: "open",
  };
  const { getAgentService } = await import("../AgentService.js");
  const agent = getAgentService();
  const title = `@${item.fromName}: ${item.action?.title ?? item.text}`.slice(0, 80);
  const chatId = await agent.createChat(undefined, title);
  const msg = cardMessage(chatId, card);
  await agent.getStorageManager().saveMessage(chatId, msg);
  (await cards()).set(itemId, { chatId, messageId: msg.id, card });
  await saveCards();
  broadcast({ type: "chat:list-updated" });
  broadcast({ type: "chat:message-received", data: { chatId, message: msg } });
  tryNotify({
    key: mentionNoticeKey(itemId), kind: "mention", type: "event", level: "priority",
    title: item.action ? `${item.fromName}: ${item.action.title}` : `${item.fromName} mentioned you`,
    body: item.text.slice(0, 200),
    source: { type: "platform", id: "people", name: "People" },
    owner: { kind: "chat", id: chatId, name: title },
    actions: [{ label: "Reply", intent: "open" }],
  });
}

async function receiveReply(e: CollabEvent): Promise<void> {
  const d = (e.detail ?? {}) as { fromName?: string; text?: string; status?: string; context?: MentionContext; action?: MentionAction | null };
  const who = d.fromName || "Someone";
  const first = who.split(" ")[0];
  const what = d.action?.title ?? "what you asked";
  const turn = d.status === "done" || d.status === "dismissed"; // your move now
  const chatId = d.context?.chatId;
  const { getAgentService } = await import("../AgentService.js");
  const storage = getAgentService().getStorageManager();
  const local = chatId ? await storage.getChat(chatId).catch(() => null) : null;
  const said = d.text ? `\n\n> ${d.text.split("\n").join("\n> ")}` : "";
  const content = d.status === "done" ? `**${first} finished: ${what}.**${said}\n\nYour turn. Pick up where you left off, or tell me what's next.`
    : d.status === "dismissed" ? `**${first} can't take it: ${what}.**${said}\n\nWant me to ask someone else, or should we do it here?`
    : `**${first} took it: ${what}.**${said}`;
  if (local && chatId) {
    const msg: StoredMessage = { id: `msg-${uuidv4()}`, chat_id: chatId, role: "assistant", sync_status: "local", timestamp: new Date().toISOString(), content };
    await storage.saveMessage(chatId, msg);
    broadcast({ type: "chat:message-received", data: { chatId, message: msg } });
  }
  if (e.requestId) broadcast({ type: "collab:mention", data: { itemId: e.requestId } });
  const owner = local && chatId ? { kind: "chat" as const, id: chatId, name: local.title } : { kind: "account" as const, id: "people", name: "People" };
  if (!turn) return; // "took it" is status, not a notice: it shows under Waiting on and in the chat
  tryNotify({
    key: `mention.done:${e.requestId ?? e.id}`, kind: "mention.done", type: "event", level: "priority",
    title: d.status === "done" ? `Your turn: ${first} finished ${lowerFirst(what)}` : `${first} can't take it: ${lowerFirst(what)}`,
    body: d.text || undefined, source: { type: "platform", id: "people", name: "People" }, owner,
    actions: [{ label: "Continue in chat", intent: "open" }],
  });
}

/** Called from the heartbeat event poll with this page's mention events. Never throws. */
export async function handleCollabEvents(events: CollabEvent[]): Promise<void> {
  for (const e of events) {
    try {
      if (e.type === "mention") await receiveMention(e);
      else if (e.type === "mention.replied") await receiveReply(e);
    } catch (err) {
      console.warn("[Mentions] event failed:", (err as Error).message.slice(0, 160));
    }
  }
}
