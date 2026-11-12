/**
 * collab:* — mentions between people.
 *   collab:members → teammates for the @ picker (you excluded)
 *   collab:answer  → { itemId, status, reply? } send the (approved) reply; open = I'm on it (in progress), done, dismissed = can't
 *   collab:notify  → { ids, note? } the user said yes to Pen's "Ask Shawkat?": tell them now
 *   collab:card    → { itemId } the Focus card for a mention that arrived here
 *   collab:approve-plan → { itemId } the user OK'd Pen's plan for a mention (the chat then runs it)
 *   collab:waiting → what the user asked others that's still open (Waiting on, in Focus)
 *   collab:followup → { itemId, kind: reply|nudge|close, text? } the asker follows up from Waiting on
 *   collab:asks    → { asks, plan } every open ask to you with Pen + Jev's ranking; today's plan with placed asks
 *   collab:goals   → { items: [{ key, text }] } which of Your three each Needs-you item moves (Jev; null = none)
 */
import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";

const STATUSES = new Set(["open", "done", "dismissed"]);

export async function setupCollabHandlers(ws: WebSocket, message: WSMessage): Promise<void> {
  try {
    const p = (message.payload ?? {}) as Record<string, unknown>;
    switch (message.type) {
      case "collab:members": {
        const { team } = await import("../../core/tools/collab.js");
        const { getPaprUserId } = await import("../utils/paprUserId.js");
        const me = getPaprUserId();
        const members = (await team()).filter((m) => m.userId !== me);
        sendResponse(ws, { id: message.id, success: true, data: { members } });
        return;
      }
      case "collab:answer": {
        const status = typeof p.status === "string" && STATUSES.has(p.status) ? (p.status as "open" | "done" | "dismissed") : "done";
        if (typeof p.itemId !== "string" || !p.itemId) throw new Error("itemId required");
        const reply = typeof p.reply === "string" && p.reply.trim() ? p.reply.trim().slice(0, 4000) : undefined;
        const { answerMention } = await import("../services/collab/mentions.js");
        const m = await answerMention(p.itemId, status, reply);
        sendResponse(ws, { id: message.id, success: true, data: { status: m.status } });
        return;
      }
      case "collab:notify": {
        const ids = Array.isArray(p.ids) ? p.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
        if (!ids.length) throw new Error("ids required");
        const note = typeof p.note === "string" && p.note.trim() ? p.note.trim().slice(0, 4000) : undefined;
        const { notifyMentions } = await import("../services/collab/mentions.js");
        const out = await notifyMentions(ids, note);
        sendResponse(ws, { id: message.id, success: true, data: { notified: out.map((m) => ({ id: m.id, name: m.toName })) } });
        return;
      }
      case "collab:approve-plan": {
        if (typeof p.itemId !== "string" || !p.itemId) throw new Error("itemId required");
        const { approvePlan } = await import("../services/collab/mentions.js");
        await approvePlan(p.itemId);
        sendResponse(ws, { id: message.id, success: true, data: { ok: true } });
        return;
      }
      case "collab:card": {
        if (typeof p.itemId !== "string" || !p.itemId) throw new Error("itemId required");
        const { mentionCard } = await import("../services/collab/mentions.js");
        sendResponse(ws, { id: message.id, success: true, data: { card: await mentionCard(p.itemId) } });
        return;
      }
      case "collab:waiting": {
        const { waitingOn } = await import("../services/collab/mentions.js");
        const rows = await waitingOn().catch(() => []);
        sendResponse(ws, { id: message.id, success: true, data: { waiting: rows.map((m) => ({
          id: m.id, toName: m.toName, title: m.action?.title ?? m.text.slice(0, 120), due: m.action?.due ?? null, blocks: m.action?.blocks ?? null,
          state: m.progress === "in_progress" || (m.progress == null && m.reply) ? "in_progress" : "asked",
          reply: m.reply?.text ?? null, replyAt: m.reply?.at ?? null,
          mine: [...(m.thread ?? [])].reverse().find((t) => t.by === "from") ?? null,
          nudgedAt: m.nudgedAt ?? null, promisedAt: m.promisedAt ?? null, chatId: m.context?.chatId ?? null, chatTitle: m.context?.chatTitle ?? null, at: m.createdAt,
        })) } });
        return;
      }
      case "collab:followup": {
        const kind = p.kind === "reply" || p.kind === "nudge" || p.kind === "close" ? p.kind : null;
        if (typeof p.itemId !== "string" || !p.itemId || !kind) throw new Error("itemId and kind (reply, nudge, close) required");
        const text = typeof p.text === "string" && p.text.trim() ? p.text.trim().slice(0, 4000) : undefined;
        if (kind === "reply" && !text) throw new Error("Write something to send");
        const { followUp } = await import("../services/collab/mentions.js");
        const m = await followUp(p.itemId, kind, text);
        sendResponse(ws, { id: message.id, success: true, data: { status: m.status, progress: m.progress ?? null } });
        return;
      }
      case "collab:asks": {
        const { openAsks } = await import("../services/collab/mentions.js");
        const { todaysPlan } = await import("../services/collab/askTriage.js");
        const [asks, plan] = await Promise.all([openAsks().catch(() => []), todaysPlan().catch(() => [])]);
        sendResponse(ws, { id: message.id, success: true, data: { asks, plan } });
        return;
      }
      case "collab:goals": {
        const items = (Array.isArray(p.items) ? p.items : [])
          .filter((x): x is { key: string; text: string } => !!x && typeof (x as { key?: unknown }).key === "string" && typeof (x as { text?: unknown }).text === "string")
          .slice(0, 60).map((x) => ({ key: x.key, text: x.text.slice(0, 500) }));
        const { getFocus } = await import("../services/focusGoals.js");
        const goals = (await getFocus()).three.map((g) => ({ id: g.id, title: g.title, scope: g.scope ?? g.target }));
        const { goalsForNeeds } = await import("../services/needsGoals.js");
        sendResponse(ws, { id: message.id, success: true, data: { goals: items.length ? await goalsForNeeds(goals, items) : {} } });
        return;
      }
      default:
        sendError(ws, message.id, `Unknown collab message: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error instanceof Error ? error : String(error));
  }
}
