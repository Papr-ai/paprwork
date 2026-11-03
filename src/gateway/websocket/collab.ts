/**
 * collab:* — mentions between people.
 *   collab:members → teammates for the @ picker (you excluded)
 *   collab:answer  → { itemId, status, reply? } send the (approved) reply; open = took it, done, dismissed = can't
 *   collab:notify  → { ids, note? } the user said yes to Pen's "Ask Shawkat?": tell them now
 *   collab:card    → { itemId } the Focus card for a mention that arrived here
 *   collab:waiting → what the user asked others that's still open (Waiting on, in Focus)
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
          id: m.id, toName: m.toName, title: m.action?.title ?? m.text.slice(0, 120), due: m.action?.due ?? null,
          state: m.reply ? "took" : "asked", reply: m.reply?.text ?? null, chatId: m.context?.chatId ?? null, chatTitle: m.context?.chatTitle ?? null, at: m.createdAt,
        })) } });
        return;
      }
      default:
        sendError(ws, message.id, `Unknown collab message: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error instanceof Error ? error : String(error));
  }
}
