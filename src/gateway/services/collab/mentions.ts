/**
 * Mentions between people (memory server /v1/cloud/collab/mentions).
 *
 *   Send:    you @-mention a teammate, or Pen tags one (mention_person): recorded quietly.
 *   Notify:  only after the user says yes: the Ask card (collab:notify) or notify_people with those ids.
 *   Suggest: an @ is context for Pen. When Pen thinks someone should do something it tags them quietly
 *            with the ask; the sender's chat shows "Ask Shawkat?" and nothing is sent until they say yes.
 *   Receive: the heartbeat event feed brings `mention`; it lands in Focus (Needs you) as the sender's ask
 *            with Pen's drafted reply: I'm on it, Can't, Later. A chat holds it for Pen's help.
 *   Track:   the sender's Focus lists open asks under "Waiting on" (Asked, In progress) with the latest reply,
 *            and Reply / Nudge / Close right on the row (followUp → mention.followup to them).
 *   Back:    `mention.replied` posts in the chat it came from. Done or can't = "Your turn" in Focus.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { broadcast } from "../../websocket/index.js";
import { tryNotify, tryResolve } from "../notifications/NoticeService.js";
import type { StoredMessage } from "../storage/IStorageProvider.js";
import { dueDate, parsePromise, promiseLabel } from "../../../core/collab/promised.js";
import type { Triage } from "./askTriage.js";

export interface MentionAction { title: string; due?: string | null; blocks?: string | null }
export interface MentionContext { chatId?: string; chatTitle?: string; appId?: string; appName?: string; goalId?: string }
export interface MentionItem {
  orgId?: string; id: string; fromUserId: string; fromName: string; toUserId: string; toName: string; text: string;
  context: MentionContext; action: MentionAction | null; status: "open" | "done" | "dismissed";
  reply: { text: string; at: string } | null; createdAt: string; notified?: boolean;
  progress?: "asked" | "in_progress" | "needs_reply" | "done" | "cant" | "closed";
  thread?: Array<{ by: "from" | "to"; text: string; at: string }>; nudgedAt?: string | null; updatedAt?: string;
  /** When they said they'd have it ("Thursday morning" → ISO). Both sides track it. */
  promisedAt?: string | null;
  /** Pen + Jev's ranking (recipient only): when, which goal, why, where it sits in today's plan. */
  triage?: (Triage & { at?: string }) | null;
}
/** What the chat card renders. Stored as the result of a `mention_inbox` tool call on the message. */
export interface MentionCardData {
  type: "mention_inbox"; itemId: string; fromName: string; text: string; context: MentionContext;
  action: MentionAction | null; suggestedReply: string; nextStep?: string;
  status: "open" | "done" | "dismissed"; sentReply?: string;
  /** Pen is checking the claim (read-only) before the draft is final. */
  investigating?: boolean;
  /** What Pen verified, in a sentence or two. */
  findings?: string;
  /** Steps for the user to approve: "check" = read-only, "change" = writes something. */
  plan?: PlanStep[];
  planStatus?: "approved";
  promisedAt?: string | null; remindedAt?: string | null;
  /** Pen + Jev's ranking, once it's in. */
  triage?: Triage | null;
}
export interface PlanStep { step: string; kind: "check" | "change" }
export interface CollabEvent {
  id: string; type: string; requestId?: string | null; actorUserId?: string | null;
  title?: string | null; detail?: Record<string, unknown>; createdAt: string;
}

export const MENTION_TOOL = "mention_inbox";
export const COLLAB_EVENTS = new Set(["mention", "mention.replied", "mention.followup"]);
export const isCollabEvent = (e: { type: string }) => COLLAB_EVENTS.has(e.type);
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
  call<{ members: Array<{ userId: string; displayName: string; email: string; imageUrl?: string | null }> }>("/members").then((r) => r.members);

export const getMention = (id: string) => call<{ mention: MentionItem }>(`/mentions/${encodeURIComponent(id)}`).then((r) => r.mention);
export const listMentions = (box: "inbox" | "sent" = "inbox", status: string | null = "open") =>
  call<{ mentions: MentionItem[] }>(`/mentions?box=${box}${status ? `&status=${status}` : "&status="}`).then((r) => r.mentions);

/** Save Pen + Jev's ranking on the ask (server), and on this machine's card. */
export async function saveTriage(itemId: string, triage: Triage): Promise<void> {
  await call(`/mentions/${encodeURIComponent(itemId)}/triage`, "POST", { triage });
  await updateCard(itemId, { triage });
  broadcast({ type: "collab:mention", data: { itemId } });
}

/** Answer a mention: send the reply (optional) and close it. Updates the card and clears the notice. */
export async function answerMention(
  itemId: string, status: "open" | "done" | "dismissed", reply?: string, needsReply = false,
): Promise<MentionItem> {
  // "I'll have it Thursday morning" → the date both sides track. Read here, in the replier's own time zone.
  const promised = status === "open" && reply ? parsePromise(reply) : null;
  const out = await call<{ mention: MentionItem }>(`/mentions/${encodeURIComponent(itemId)}/resolve`, "POST",
    { status, reply, ...(promised ? { promisedAt: promised.toISOString() } : {}), ...(needsReply && status === "open" ? { needsReply: true } : {}) });
  // "I'm on it" keeps it open: it stays on Focus (In progress) until you mark it done.
  if (status !== "open") { tryResolve(mentionNoticeKey(itemId)); tryResolve(`mention.due:${itemId}`); }
  await updateCard(itemId, { status: out.mention.status, ...(reply ? { sentReply: reply } : {}),
    ...(promised ? { promisedAt: promised.toISOString(), remindedAt: null } : {}) });
  return out.mention;
}

/** The asker, from Waiting on: reply to them, nudge them, or close the ask ("don't need it anymore"). */
export async function followUp(itemId: string, kind: "reply" | "nudge" | "close", text?: string): Promise<MentionItem> {
  const out = await call<{ mention: MentionItem }>(`/mentions/${encodeURIComponent(itemId)}/followup`, "POST", { kind, text });
  const chatId = out.mention.context?.chatId;
  if (chatId && kind !== "nudge") {
    const first = out.mention.toName.split(" ")[0];
    await postToChat(chatId, kind === "reply" ? `**You replied to** @${first}\n\n> ${text!.split("\n").join("\n> ")}` : `**Closed.** @${first} was told you don't need it anymore.`);
  }
  broadcast({ type: "collab:mention", data: { itemId } });
  return out.mention;
}

async function postToChat(chatId: string, content: string): Promise<void> {
  const { getAgentService } = await import("../AgentService.js");
  const storage = getAgentService().getStorageManager();
  if (!(await storage.getChat(chatId).catch(() => null))) return;
  const msg: StoredMessage = { id: `msg-${uuidv4()}`, chat_id: chatId, role: "assistant", sync_status: "local", timestamp: new Date().toISOString(), content };
  await storage.saveMessage(chatId, msg);
  broadcast({ type: "chat:message-received", data: { chatId, message: msg } });
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
  const fallback = { reply: item.action ? `On it. I'll ${lowerFirst(item.action.title)}${item.action.due ? ` by ${dueDate(item.action.due)}` : ""}.` : "Thanks, got it." };
  try {
    const { generateSimpleText } = await import("../../utils/simpleTextGeneration.js");
    const voice = await myVoice();
    const raw = await generateSimpleText(
      "You are Pen, a teammate's work assistant. Someone mentioned your user. Draft the short reply your user would send back " +
        "(first person, plain, at most 2 sentences, no greeting fluff), in the user's own voice, and the one next step they should take. " +
        'Answer only JSON: {"reply": "...", "nextStep": "..."}',
      [mentionBrief(item), voice].filter(Boolean).join("\n\n"),
      300,
      "[Mentions]",
    );
    return parseSuggestion(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function mentionBrief(item: MentionItem): string {
  return [
    `${item.fromName} wrote to ${item.toName}${item.context.chatTitle ? ` (from the chat "${item.context.chatTitle}")` : ""}:`,
    item.text,
    item.action ? `Action asked of ${item.toName}: ${item.action.title}${item.action.due ? ` (due ${dueDate(item.action.due)})` : ""}` : "",
  ].filter(Boolean).join("\n");
}

/** How the user actually answers teammates: their last few sent replies, as style examples. */
async function myVoice(): Promise<string> {
  const rows = await listMentions("inbox", null).catch(() => [] as MentionItem[]);
  const said = rows.filter((m) => m.reply?.text).slice(0, 6).map((m) => `- to ${m.fromName.split(" ")[0]}: "${m.reply!.text.slice(0, 220)}"`);
  return said.length ? `How ${rows[0].toName.split(" ")[0]} usually replies (match this tone and length):\n${said.join("\n")}` : "";
}

/** Read-only tools Pen may use to check a mention before drafting. No writes, no messages sent. */
export const MENTION_CHECK_TOOLS = [
  "search_agent_memory", "search_wiki_entities", "get_wiki_entity", "list_mentions", "list_documents", "read_document",
  "read_file", "search_files", "list_apps", "list_app_files", "read_app_file", "read_app_data_sources", "read_app_data_health",
  "list_jobs", "read_job_file", "read_job_logs", "papr_db_query", "papr_db_sync_status", "query_cloud_turso",
  "get_cloud_sync_status", "inspect_cloud_repo",
];

export function parseInvestigation(raw: string | null): { reply: string; nextStep?: string; findings?: string; why?: string; plan: PlanStep[] } | null {
  const base = parseSuggestion(raw);
  if (!base || !raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : raw) as { findings?: unknown; why?: unknown; plan?: unknown };
    const plan = (Array.isArray(j.plan) ? j.plan : []).flatMap((x): PlanStep[] => {
      const o = x as { step?: unknown; kind?: unknown };
      return typeof o?.step === "string" && o.step.trim() ? [{ step: o.step.trim().slice(0, 300), kind: o.kind === "change" ? "change" : "check" }] : [];
    }).slice(0, 6);
    return { ...base, ...(typeof j.findings === "string" && j.findings.trim() ? { findings: j.findings.trim().slice(0, 800) } : {}),
      ...(typeof j.why === "string" && j.why.trim() ? { why: j.why.trim().slice(0, 300) } : {}), plan };
  } catch {
    return { ...base, plan: [] };
  }
}

const INVESTIGATE_MS = 150_000;

/** Pen checks what the teammate reported (read-only), then drafts the reply and a plan for the user to approve. */
async function investigate(item: MentionItem): Promise<ReturnType<typeof parseInvestigation>> {
  const { getAgentService } = await import("../AgentService.js");
  const prompt = [
    "A teammate mentioned your user. Before drafting a reply, VERIFY what they said using read-only tools:",
    "also read the user's goals (workspace/IDENTITY.md → Goals) and what they're working on, so you can say how much this matters to them.",
    "search memory and the wiki for context and how the user handled similar things, and if they report a problem (an app, job, database, sync issue),",
    "look at it with the read/query tools. Never change anything, never send messages. Keep it to a few focused checks.",
    "",
    mentionBrief(item),
    "",
    await myVoice(),
    "",
    "Then answer ONLY with JSON:",
    '{"findings": "1-2 sentences: what you checked and what is actually true (say plainly if you could not verify)",',
    ' "reply": "the reply your user would send, first person, in their voice, at most 3 sentences, grounded in the findings",',
    ' "nextStep": "one line",',
    ' "why": "one line for the user: how much this matters now and why (who is blocked, which goal, what deadline). Plain words.",',
    ' "plan": [{"step": "concrete step", "kind": "check" | "change"}]}',
    'Plan: 1-5 steps to resolve it. "check" = read-only, "change" = edits code, data, links or settings. Empty if nothing to do.',
  ].join("\n");
  const run = getAgentService().runIsolatedJobSession({
    jobId: `mention-${item.id}`, runId: `${Date.now()}`, prompt, allowedToolIds: MENTION_CHECK_TOOLS, maxTurns: 12,
  }).then((r) => parseInvestigation(r.text));
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), INVESTIGATE_MS));
  return Promise.race([run, timeout]).catch(() => null);
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// ── Incoming events ───────────────────────────────────────────────────────────

export function mentionMessageText(c: MentionCardData): string {
  const where = c.context.chatTitle ? ` in “${c.context.chatTitle}”` : "";
  return [
    `**${c.fromName} mentioned you${where}**`,
    `> ${c.text.split("\n").join("\n> ")}`,
    c.action ? `**For you:** ${c.action.title}${c.action.due ? ` (due ${dueDate(c.action.due)})` : ""}` : "",
    `**Suggested reply:** ${c.suggestedReply}`,
    c.nextStep ? `**Next step:** ${c.nextStep}` : "",
    c.findings ? `**What I checked:** ${c.findings}` : "",
    c.plan?.length ? `**Plan (needs your OK):**\n${c.plan.map((p, i) => `${i + 1}. ${p.step}${p.kind === "change" ? " _(change)_" : ""}`).join("\n")}` : "",
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
/** The user approved Pen's plan: mark it, so the card shows it's underway. */
export const approvePlan = (itemId: string) => updateCard(itemId, { planStatus: "approved" });

export async function mentionCard(itemId: string): Promise<(MentionCardData & { chatId: string }) | null> {
  const hit = (await cards()).get(itemId);
  return hit ? { ...hit.card, chatId: hit.chatId } : null;
}

/** The sender's open asks that were sent, for "Waiting on" in Focus. */
export async function waitingOn(): Promise<MentionItem[]> {
  const org = process.env.PAPR_ORG_ID;
  return (await listMentions("sent", "open")).filter((m) => m.notified !== false && (!m.orgId || !org || m.orgId === org));
}

/** Every open ask to you in this org, ranked by Pen + Jev: placed first, then now → fyi, then unranked. */
export async function openAsks(): Promise<(MentionItem & { chatId?: string })[]> {
  const org = process.env.PAPR_ORG_ID;
  const order = { now: 0, today: 1, this_week: 2, fyi: 3 } as Record<string, number>;
  const rows = (await listMentions("inbox", "open")).filter((m) => !m.orgId || !org || m.orgId === org);
  const c = await cards();
  return rows
    .map((m) => ({ ...m, chatId: c.get(m.id)?.chatId }))
    .sort((a, b) => Number(!!b.triage?.placed) - Number(!!a.triage?.placed)
      || (order[a.triage?.when ?? ""] ?? 9) - (order[b.triage?.when ?? ""] ?? 9) || b.createdAt.localeCompare(a.createdAt));
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
    action: item.action, suggestedReply: s.reply, ...(s.nextStep ? { nextStep: s.nextStep } : {}), status: "open", investigating: true,
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
  // Focus may already show this ask (its notice can sync from another device first) and
  // looked the card up before it existed: send it so the item fills in without a reload.
  broadcast({ type: "collab:card", data: { itemId, card } });
  tryNotify({
    key: mentionNoticeKey(itemId), kind: "mention", type: "event", level: "priority",
    title: item.action ? `${item.fromName}: ${item.action.title}` : `${item.fromName} mentioned you`,
    body: item.text.slice(0, 200),
    source: { type: "platform", id: "people", name: "People" },
    owner: { kind: "chat", id: chatId, name: title },
    actions: [{ label: "Reply", intent: "open" }],
  });
  void investigate(item).then(async (r) => {
    const live = (await cards()).get(itemId);
    if (!live || live.card.status !== "open") return;
    // The card keeps the user's own edits (it only swaps the draft if they haven't touched it).
    await updateCard(itemId, r ? {
      investigating: false, suggestedReply: r.reply, findings: r.findings, plan: r.plan, ...(r.nextStep ? { nextStep: r.nextStep } : {}),
    } : { investigating: false });
    // Then Jev ranks it with what Pen found, against your goals and today's plan.
    const { queueTriage } = await import("./askTriage.js");
    queueTriage({ item, findings: r?.findings, why: r?.why });
  }).catch(() => updateCard(itemId, { investigating: false }));
}

async function receiveReply(e: CollabEvent): Promise<void> {
  const d = (e.detail ?? {}) as { fromName?: string; text?: string; status?: string; progress?: string; context?: MentionContext; action?: MentionAction | null; promisedAt?: string | null };
  const who = d.fromName || "Someone";
  const first = who.split(" ")[0];
  const what = d.action?.title ?? "what you asked";
  const turn = d.status === "done" || d.status === "dismissed"; // your move now
  const chatId = d.context?.chatId;
  const { getAgentService } = await import("../AgentService.js");
  const storage = getAgentService().getStorageManager();
  const local = chatId ? await storage.getChat(chatId).catch(() => null) : null;
  const said = d.text ? `\n\n> ${d.text.split("\n").join("\n> ")}` : "";
  // Short, in the chat the ask came from: Pen picks the work back up from here.
  const by = d.promisedAt ? ` · by ${promiseLabel(d.promisedAt)}` : "";
  // "@name" renders as a person pill in chat. One status line, then their words.
  const at = `@${who.split(" ").length > 1 ? who : first}`;
  const content = d.status === "done" ? `${at} **finished** · ${what}${said}`
    : d.status === "dismissed" ? `${at} **can't take it** · ${what}${said}\n\nAsk someone else, or do it here?`
    : d.progress === "needs_reply" ? `${at} **needs your reply** · ${what}${said}\n\nAnswer them here and I'll send it.`
    : `${at} **is on it**${by} · ${what}${said}`;
  if (local && chatId) {
    const msg: StoredMessage = { id: `msg-${uuidv4()}`, chat_id: chatId, role: "assistant", sync_status: "local", timestamp: new Date().toISOString(), content };
    await storage.saveMessage(chatId, msg);
    broadcast({ type: "chat:message-received", data: { chatId, message: msg } });
  }
  if (e.requestId) broadcast({ type: "collab:mention", data: { itemId: e.requestId } });
  const owner = local && chatId ? { kind: "chat" as const, id: chatId, name: local.title } : { kind: "account" as const, id: "people", name: "People" };
  if (d.progress === "needs_reply") {
    // Their move, not a status: it sits on your Focus until you answer (the server clears it when you reply).
    tryNotify({
      key: `mention.needs_reply:${e.requestId ?? e.id}`, kind: "mention.needs_reply", type: "event", level: "priority",
      title: `${first} needs your reply: ${lowerFirst(what)}`, body: d.text || undefined,
      source: { type: "platform", id: "people", name: "People" }, owner, actions: [{ label: "Reply", intent: "open" }],
    });
    return;
  }
  if (!turn) return; // "in progress" is status, not a notice: it shows under Waiting on and in the chat
  tryNotify({
    key: `mention.done:${e.requestId ?? e.id}`, kind: "mention.done", type: "event", level: "priority",
    title: d.status === "done" ? `Your turn: ${first} finished ${lowerFirst(what)}` : `${first} can't take it: ${lowerFirst(what)}`,
    body: d.text || undefined, source: { type: "platform", id: "people", name: "People" }, owner,
    actions: [{ label: "Continue in chat", intent: "open" }],
  });
}

/** The asker followed up (reply, nudge, close). Shows on your ask's card and chat; close takes it off Focus. */
async function receiveFollowUp(e: CollabEvent): Promise<void> {
  const d = (e.detail ?? {}) as { kind?: string; fromName?: string; text?: string; what?: string };
  const itemId = e.requestId ?? "";
  const who = (d.fromName || "Someone").split(" ")[0];
  const hit = itemId ? (await cards()).get(itemId) : undefined;
  if (hit) {
    const line = d.kind === "reply" ? `**${who} replied:**\n\n> ${(d.text || "").split("\n").join("\n> ")}`
      : d.kind === "nudge" ? `**${who} is checking in** on ${lowerFirst(d.what || "this")}.`
      : `**${who} doesn't need this anymore:** ${d.what || ""}. Nothing more to do.`;
    await postToChat(hit.chatId, line);
  }
  if (d.kind === "close") {
    tryResolve(mentionNoticeKey(itemId));
    await updateCard(itemId, { status: "dismissed" });
  } else {
    tryNotify({
      key: mentionNoticeKey(itemId), kind: "mention", type: "event", level: "priority",
      title: d.kind === "reply" ? `${who} replied: ${d.what ?? ""}` : `${who} is checking in: ${d.what ?? ""}`,
      body: d.text || undefined, source: { type: "platform", id: "people", name: "People" },
      owner: hit ? { kind: "chat", id: hit.chatId, name: hit.card.action?.title ?? "Mention" } : { kind: "account", id: "people", name: "People" },
      actions: [{ label: "Reply", intent: "open" }],
    });
  }
  if (itemId) broadcast({ type: "collab:mention", data: { itemId } });
}

/** Called from the heartbeat event poll with this page's mention events. Never throws. */
export async function handleCollabEvents(events: CollabEvent[]): Promise<void> {
  for (const e of events) {
    try {
      if (e.type === "mention") await receiveMention(e);
      else if (e.type === "mention.replied") await receiveReply(e);
      else if (e.type === "mention.followup") await receiveFollowUp(e);
    } catch (err) {
      console.warn("[Mentions] event failed:", (err as Error).message.slice(0, 160));
    }
  }
}

/** Hold people to what they said: an hour before the time they promised, re-raise the ask in their Focus.
 *  Runs on the desktop heartbeat. One reminder per promise (a new promise resets it). */
export async function remindPromises(now = new Date()): Promise<number> {
  let n = 0;
  for (const [itemId, ref] of await cards()) {
    const c = ref.card;
    if (c.status !== "open" || !c.promisedAt || c.remindedAt) continue;
    const due = new Date(c.promisedAt);
    if (now.getTime() < due.getTime() - 3_600_000) continue;
    c.remindedAt = now.toISOString(); n++;
    const what = c.action?.title ?? c.text.slice(0, 80);
    tryNotify({
      key: `mention.due:${itemId}`, kind: "mention.due", type: "condition", level: "priority",
      title: `${now > due ? "Was due" : "Due"} ${promiseLabel(due, now)}: ${what}`,
      body: `You told ${c.fromName.split(" ")[0]} ${promiseLabel(due, now)}.`,
      source: { type: "platform", id: "people", name: "People" },
      owner: { kind: "chat", id: ref.chatId, name: what },
      actions: [{ label: "Open", intent: "open" }],
    });
  }
  if (n) await saveCards();
  return n;
}

