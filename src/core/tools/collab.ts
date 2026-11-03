/**
 * People tools: mention a teammate (with an optional action for them), answer a mention, list mentions.
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

export const mentionPersonTool = createTool({
  id: "mention_person",
  description:
    "Ping a teammate in Papr Work: they get a notice and a chat with your message, the action you ask of them, and a reply their Pen drafts for them to approve. " +
    "Use it PROACTIVELY when a decision or approval in this chat creates work or a question for a specific person (e.g. the user approves Shawkat's proposal → tell Shawkat what's next). " +
    "Say who you're pinging and why in your reply. Don't ping for FYI chatter, and don't ping the user themselves. " +
    "people: names, emails or user ids (one teammate each). action: the one thing you need them to do, if any.",
  inputSchema: z.object({
    people: z.array(z.string().min(1)).min(1).max(10).describe("Teammates to ping: name, email or user id"),
    message: z.string().min(1).max(4000).describe("What to tell them, written to them, with the context they need"),
    action: z.object({ title: z.string().min(1).max(200), due: z.string().optional().describe("YYYY-MM-DD") }).optional()
      .describe("The one thing you're asking them to do. Becomes a task on their Focus."),
  }),
  execute: async (args) => {
    try {
      const members = await team();
      const { getPaprUserId } = await import("../../gateway/utils/paprUserId.js");
      const me = getPaprUserId();
      const picked: Teammate[] = [];
      for (const p of args.people) {
        const m = matchTeammate(p, members);
        if ("error" in m) return { success: false, error: m.error };
        if (m.userId === me) return { success: false, error: "That's you. Mention someone else." };
        if (!picked.some((x) => x.userId === m.userId)) picked.push(m);
      }
      const { getCurrentChatId } = await import("./context.js");
      const { sendMention } = await import("../../gateway/services/collab/mentions.js");
      const sent = await sendMention({
        toUserIds: picked.map((m) => m.userId), text: args.message, chatId: getCurrentChatId() ?? undefined, action: args.action ?? null,
      });
      return { success: true, data: { sentTo: picked.map((m) => m.displayName), mentionIds: sent.map((s) => s.id), action: args.action ?? null } };
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
  description: "List mentions: inbox = teammates asking the user something (open by default), sent = what the user (or you) asked of others and whether they answered.",
  inputSchema: z.object({ box: z.enum(["inbox", "sent"]).default("inbox"), status: z.enum(["open", "done", "dismissed", "all"]).default("open") }),
  execute: async (args) => {
    try {
      const { listMentions } = await import("../../gateway/services/collab/mentions.js");
      const rows = await listMentions(args.box, args.status === "all" ? null : args.status);
      return { success: true, data: rows.map((m) => ({ id: m.id, from: m.fromName, to: m.toName, text: m.text.slice(0, 300), action: m.action, status: m.status, reply: m.reply?.text ?? null, at: m.createdAt })) };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const collabTools = [mentionPersonTool, answerMentionTool, listMentionsTool];
