/**
 * collab:* — mentions between people.
 *   collab:members → teammates for the @ picker (you excluded)
 *   collab:answer  → { itemId, status, reply? } send the (approved) reply and close the mention
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
        const { listNamespaceUsersForAgent } = await import("../services/namespaceUsersService.js");
        const { getPaprUserId } = await import("../utils/paprUserId.js");
        const me = getPaprUserId();
        const r = await listNamespaceUsersForAgent();
        const members = r.members
          .filter((m) => m.externalUserId !== me)
          .map((m) => ({ userId: m.externalUserId, displayName: m.displayName || m.email, email: m.email }));
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
      default:
        sendError(ws, message.id, `Unknown collab message: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error instanceof Error ? error : String(error));
  }
}
