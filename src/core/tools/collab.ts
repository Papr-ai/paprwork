/**
 * People tools: tag a teammate (quiet), notify them on the user's behalf, answer a mention, list mentions.
 * Backed by the memory server's /v1/cloud/collab/mentions; delivery rides the heartbeat event feed.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { MentionItem } from "../../gateway/services/collab/mentions.js";

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

/** Open asks these people already sent the user. Pen answers those instead of starting a second thread. */
export function openAsksFrom<T extends { fromUserId: string }>(inbox: T[], people: Teammate[]): T[] {
  const ids = new Set(people.map((p) => p.userId));
  return inbox.filter((m) => ids.has(m.fromUserId));
}

/** Everything Pen needs to see about one mention: where it stands, the exchange so far, what it's about. */
export function mentionSummary(m: MentionItem) {
  return {
    id: m.id, from: m.fromName, to: m.toName, text: m.text.slice(0, 300), action: m.action, status: m.status,
    progress: m.progress ?? (m.reply ? "in_progress" : "asked"), notified: m.notified !== false, reply: m.reply?.text ?? null,
    thread: (m.thread ?? []).slice(-6).map((t) => ({ by: t.by, text: t.text.slice(0, 300), at: t.at })),
    about: { appId: m.context?.appId ?? null, appName: m.context?.appName ?? null, chatId: m.context?.chatId ?? null },
    promisedAt: m.promisedAt ?? null, nudgedAt: m.nudgedAt ?? null, at: m.createdAt,
  };
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
    appId: z.string().optional().describe("The app this ask is about, so it's linked to that work."),
    appName: z.string().max(120).optional().describe("Name of that app."),
    force: z.boolean().default(false).describe("Send even though they have an open ask to the user. Only for a genuinely separate topic."),
  }),
  execute: async (args) => {
    try {
      const picked = await pickPeople(args.people);
      if ("error" in picked) return { success: false, error: picked.error };
      const { getCurrentChatId } = await import("./context.js");
      const { sendMention, listMentions } = await import("../../gateway/services/collab/mentions.js");
      if (!args.force) {
        const open = openAsksFrom(await listMentions("inbox", "open").catch(() => []), picked);
        if (open.length) {
          return { success: false, error: "They already have an open ask to the user. Answer that with answer_mention (status open keeps it open) so it stays one thread. " +
            "Only call mention_person again with force: true if this is a separate topic.",
            openAsks: open.map((m) => ({ mentionId: m.id, from: m.fromName, title: m.action?.title ?? m.text.slice(0, 120) })) };
        }
      }
      const sent = await sendMention({
        toUserIds: picked.map((m) => m.userId), text: args.message, chatId: getCurrentChatId() ?? undefined,
        action: args.action ?? null, notify: args.notify,
        context: args.appId ? { appId: args.appId, ...(args.appName ? { appName: args.appName } : {}) } : undefined,
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
    "pass their reply (or the suggested one they approved). status done = handled, dismissed = not doing it, open = reply but keep it open. " +
    "When you replied because you need something from them before you can continue, also set needsReply: true so it shows as waiting on them, not \"on it\".",
  inputSchema: z.object({
    mentionId: z.string().min(1),
    reply: z.string().max(4000).optional(),
    status: z.enum(["done", "dismissed", "open"]).default("done"),
    needsReply: z.boolean().default(false).describe("With status open: the next move is theirs (you asked them a question or need their input)."),
  }),
  execute: async (args) => {
    try {
      const { answerMention } = await import("../../gateway/services/collab/mentions.js");
      const m = await answerMention(args.mentionId, args.status, args.reply, args.needsReply);
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
      return { success: true, data: rows.map(mentionSummary) };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const followUpMentionTool = createTool({
  id: "follow_up_mention",
  description:
    "Follow up on an ask the user SENT (list_mentions box=sent): reply = add to the thread, nudge = check in, close = withdraw it (\"don't need it anymore\"). " +
    "Use close to clear an ask that was answered elsewhere or duplicated. Only send a reply or nudge the user approved. To answer something someone sent the user, use answer_mention.",
  inputSchema: z.object({
    mentionId: z.string().min(1).describe("An ask the user sent, from list_mentions box=sent"),
    kind: z.enum(["reply", "nudge", "close"]),
    text: z.string().max(4000).optional().describe("Required for reply"),
  }),
  execute: async (args) => {
    try {
      if (args.kind === "reply" && !args.text?.trim()) return { success: false, error: "Write something to send" };
      const { followUp } = await import("../../gateway/services/collab/mentions.js");
      const m = await followUp(args.mentionId, args.kind, args.text?.trim() || undefined);
      return { success: true, data: { to: m.toName, status: m.status, progress: m.progress ?? null, kind: args.kind } };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

export const collabTools = [mentionPersonTool, notifyPeopleTool, answerMentionTool, listMentionsTool, followUpMentionTool];
