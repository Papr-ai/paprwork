/**
 * People tools: tag a teammate (quiet), notify them on the user's behalf, answer a mention, list mentions.
 * Backed by the memory server's /v1/cloud/collab/mentions; delivery rides the heartbeat event feed.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export interface Teammate { userId: string; displayName: string; email: string }

/** Match "Shawkat", "shawkat@papr.ai", or a user id to exactly one teammate. */
export function matchTeammate(query: string, team: Teammate[]): Teammate | { error: string } {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (!q) return { error: "empty name" };
  const exact = team.filter((m) => m.userId.toLowerCase() === q || m.email.toLowerCase() === q || m.displayName.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const first = team.filter((m) => m.displayName.toLowerCase().split(/\s+/)[0] === q || m.email.toLowerCase().split("@")[0] === q);
  if (first.length === 1) return first[0];
  const loose = team.filter((m) => m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  if (loose.length === 1) return loose[0];
  const pool = exact.length ? exact : first.length ? first : loose;
  return pool.length
    ? { error: `"${query}" matches ${pool.map((m) => `${m.displayName} <${m.email}>`).join(", ")}. Use their email.` }
    : { error: `No one called "${query}" in this workspace.` };
}

async function team(): Promise<Teammate[]> {
  const { listNamespaceUsersForAgent } = await import("../../gateway/services/namespaceUsersService.js");
  const r = await listNamespaceUsersForAgent();
  return r.members.map((m) => ({ userId: m.externalUserId, displayName: m.displayName || m.email, email: m.email }));
}

async function pickPeople(people: string[]): Promise<Teammate[] | { error: string }> {
  const members = await team();
  const { getPaprUserId } = await import("../../gateway/utils/paprUserId.js");
  const me = getPaprUserId();
  const picked: Teammate[] = [];
  for (const p of people) {
    const m = matchTeammate(p, members);
    if ("error" in m) return m;
    if (m.userId === me) return { error: "That's you. Mention someone else." };
    if (!picked.some((x) => x.userId === m.userId)) picked.push(m);
  }
  return picked;
}

export const mentionPersonTool = createTool({
  id: "mention_person",
  description:
    "Tag teammates on something in this chat: records that they have something here (with the action for them, if any). " +
    "It does NOT tell them. They're only told when you call notify_people, or now if notify is true. " +
    "Use it when the user writes @Name, or when a decision here creates work for someone. " +
    "Set notify: true only if the user asked to tell them now. people: names, emails or user ids.",
  inputSchema: z.object({
    people: z.array(z.string().min(1)).min(1).max(10).describe("Teammates: name, email or user id"),
    message: z.string().min(1).max(4000).describe("What they have here, written to them, with the context they need"),
    action: z.object({ title: z.string().min(1).max(200), due: z.string().optional().describe("YYYY-MM-DD") }).optional()
      .describe("The one thing you're asking them to do. Lands on their Focus when they're notified."),
    notify: z.boolean().default(false).describe("Tell them now. Default false: tag quietly, notify later with notify_people."),
  }),
  execute: async (args) => {
    try {
      const picked = await pickPeople(args.people);
      if ("error" in picked) return { success: false, error: picked.error };
      const { getCurrentChatId } = await import("./context.js");
      const { sendMention } = await import("../../gateway/services/collab/mentions.js");
      const sent = await sendMention({
        toUserIds: picked.map((m) => m.userId), text: args.message, chatId: getCurrentChatId() ?? undefined,
        action: args.action ?? null, notify: args.notify,
      });
      return { success: true, data: {
        mentioned: sent.map((s) => ({ name: s.toName, mentionId: s.id })), notified: args.notify, action: args.action ?? null,
        ...(args.notify ? {} : { next: "Not told yet. Call notify_people with these mentionIds when the user wants them told." }),
      } };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const notifyPeopleTool = createTool({
  id: "notify_people",
  description:
    "Notify teammates on the user's behalf: they get a notice and a chat with the message, the action for them (as a Focus task) and a reply their Pen drafts. " +
    "Pass mentionIds of mentions the user already made (from mention_person or list_mentions box=sent), or people to tag and notify in one step. " +
    "note replaces the message they'll see, so write it to them. Only call when the user asks, or when they've clearly approved telling them; say who you notified.",
  inputSchema: z.object({
    mentionIds: z.array(z.string().min(1)).max(20).optional().describe("Mentions the user sent that haven't been notified"),
    people: z.array(z.string().min(1)).max(10).optional().describe("Or: teammates to tag and notify now"),
    note: z.string().max(4000).optional().describe("Message they'll see. Required with people."),
    action: z.object({ title: z.string().min(1).max(200), due: z.string().optional() }).optional().describe("With people: the one thing for them to do"),
  }),
  execute: async (args) => {
    try {
      const svc = await import("../../gateway/services/collab/mentions.js");
      const out: Array<{ name: string; mentionId: string }> = [];
      if (args.mentionIds?.length) {
        const r = await svc.notifyMentions(args.mentionIds, args.note);
        out.push(...r.map((m) => ({ name: m.toName, mentionId: m.id })));
      }
      if (args.people?.length) {
        if (!args.note?.trim()) return { success: false, error: "Write the note they'll see." };
        const picked = await pickPeople(args.people);
        if ("error" in picked) return { success: false, error: picked.error };
        const { getCurrentChatId } = await import("./context.js");
        const r = await svc.sendMention({ toUserIds: picked.map((m) => m.userId), text: args.note, chatId: getCurrentChatId() ?? undefined, action: args.action ?? null, notify: true });
        out.push(...r.map((m) => ({ name: m.toName, mentionId: m.id })));
      }
      if (!out.length) return { success: false, error: "Pass mentionIds or people." };
      return { success: true, data: { notified: out } };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const answerMentionTool = createTool({
  id: "answer_mention",
  description:
    "Answer a mention a teammate sent the user (the mention id is in the mention card's message). Only call after the user says what to send: " +
    "pass their reply (or the suggested one they approved). status done = handled, dismissed = not doing it, open = reply but keep it open.",
  inputSchema: z.object({
    mentionId: z.string().min(1),
    reply: z.string().max(4000).optional(),
    status: z.enum(["done", "dismissed", "open"]).default("done"),
  }),
  execute: async (args) => {
    try {
      const { answerMention } = await import("../../gateway/services/collab/mentions.js");
      const m = await answerMention(args.mentionId, args.status, args.reply);
      return { success: true, data: { status: m.status, repliedTo: m.fromName, reply: m.reply?.text ?? null } };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const listMentionsTool = createTool({
  id: "list_mentions",
  description: "List mentions: inbox = teammates asking the user something (open by default), sent = what the user (or you) tagged others on, whether they've been notified yet, and whether they answered.",
  inputSchema: z.object({ box: z.enum(["inbox", "sent"]).default("inbox"), status: z.enum(["open", "done", "dismissed", "all"]).default("open") }),
  execute: async (args) => {
    try {
      const { listMentions } = await import("../../gateway/services/collab/mentions.js");
      const rows = await listMentions(args.box, args.status === "all" ? null : args.status);
      return { success: true, data: rows.map((m) => ({ id: m.id, from: m.fromName, to: m.toName, text: m.text.slice(0, 300), action: m.action, status: m.status, notified: m.notified !== false, reply: m.reply?.text ?? null, at: m.createdAt })) };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const collabTools = [mentionPersonTool, notifyPeopleTool, answerMentionTool, listMentionsTool];
