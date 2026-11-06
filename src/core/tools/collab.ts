/**
 * People tools: tag a teammate (quiet), notify them on the user's behalf, answer a mention, list mentions.
 * Backed by the memory server's /v1/cloud/collab/mentions; delivery rides the heartbeat event feed.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export interface Teammate { userId: string; displayName: string; email: string; imageUrl?: string | null }

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

/** Teammates you can mention. Server list first (same backend as mentions); dashboard team list as fallback. */
export async function team(): Promise<Teammate[]> {
  try {
    const { listMembers } = await import("../../gateway/services/collab/mentions.js");
    const m = await listMembers();
    if (m.length) return m;
  } catch { /* older server: fall back */ }
  const { listNamespaceUsersForAgent } = await import("../../gateway/services/namespaceUsersService.js");
  const r = await listNamespaceUsersForAgent();
  return r.members.map((m) => ({ userId: m.externalUserId, displayName: m.displayName || m.email, email: m.email, imageUrl: m.imageUrl }));
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
    "Suggest asking a teammate to do something. Records the ask quietly and shows the user a card: \"Ask Shawkat?\" " +
    "with your drafted ask, which they can edit, then Ask or No. Nothing reaches the teammate until the user says yes. " +
    "Use it when the user mentions someone and you think that person should do something, or a decision creates work for them. " +
    "Set notify: true only when the user explicitly told you to ask, tell or ping them (\"ask Shawkat to…\"). Saying someone should do something is not that: suggest. people: names, emails or user ids.",
  inputSchema: z.object({
    people: z.array(z.string().min(1)).min(1).max(10).describe("Teammates: name, email or user id"),
    message: z.string().min(1).max(4000).describe("The ask, written to them in the user's voice: one clear request with the context they need"),
    action: z.object({
      title: z.string().min(1).max(200), due: z.string().optional().describe("YYYY-MM-DD"),
      blocks: z.string().max(120).optional().describe("What this unblocks for the user, if anything (\"Publish the pricing page\"). Shown on their Waiting on."),
    }).optional()
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
        type: "mention_ask", ask: args.message,
        mentioned: sent.map((s) => ({ name: s.toName, mentionId: s.id })), notified: args.notify, action: args.action ?? null,
        ...(args.notify ? {} : { next: "Not sent. The user sees an Ask card and decides. Don't call notify_people for these unless they say so in chat." }),
      } };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const notifyPeopleTool = createTool({
  id: "notify_people",
  description:
    "Send asks the user already approved. Pass the mentionIds from mention_person (or list_mentions box=sent). " +
    "Only call when the user says yes in chat (\"yes, ask him\"); the Ask card's button does the same thing. " +
    "To suggest an ask, use mention_person instead: never send one the user hasn't seen. note replaces the message they'll see.",
  inputSchema: z.object({
    mentionIds: z.array(z.string().min(1)).min(1).max(20).describe("Asks the user approved, from mention_person"),
    note: z.string().max(4000).optional().describe("Optional: the edited ask, written to them"),
  }),
  execute: async (args) => {
    try {
      const svc = await import("../../gateway/services/collab/mentions.js");
      const r = await svc.notifyMentions(args.mentionIds, args.note);
      return { success: true, data: { notified: r.map((m) => ({ name: m.toName, mentionId: m.id })),
        say: "Confirm in one short line and write each person as @Name (it shows as their pill), e.g. \"Asked @" + (r[0]?.toName ?? "Name") + " to …\"." } };
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
