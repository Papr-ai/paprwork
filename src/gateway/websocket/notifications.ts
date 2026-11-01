/**
 * notifications:* — the UI reads and clears notices.
 *   notifications:list     → open notices
 *   notifications:viewing  → what's on screen (marks it seen, suppresses FYI on it)
 *   notifications:seen     → you looked at a thing
 *   notifications:resolve  → clear one notice by key (e.g. "Not now" on a request)
 */
import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";
import { getNoticeService } from "../services/notifications/NoticeService.js";
import type { NoticeOwnerKind } from "../../core/types/notices.js";

const OWNER_KINDS = new Set<NoticeOwnerKind>(["chat", "app", "account"]);

function ownerKind(v: unknown): NoticeOwnerKind | undefined {
  return typeof v === "string" && OWNER_KINDS.has(v as NoticeOwnerKind) ? (v as NoticeOwnerKind) : undefined;
}

export async function setupNotificationHandlers(ws: WebSocket, message: WSMessage): Promise<void> {
  try {
    const service = getNoticeService();
    const p = (message.payload ?? {}) as Record<string, unknown>;
    switch (message.type) {
      case "notifications:list":
        sendResponse(ws, { id: message.id, success: true, data: service.listOpen() });
        return;
      case "notifications:viewing": {
        const owners = (Array.isArray(p.owners) ? p.owners : []).flatMap((o: unknown) => {
          const r = (o ?? {}) as Record<string, unknown>;
          const kind = ownerKind(r.kind);
          return kind && typeof r.id === "string" && r.id ? [{ kind, id: r.id }] : [];
        });
        service.setViewing({ owners, foreground: p.foreground !== false });
        sendResponse(ws, { id: message.id, success: true });
        return;
      }
      case "notifications:seen": {
        const kind = ownerKind(p.ownerKind);
        if (!kind || typeof p.ownerId !== "string") throw new Error("ownerKind and ownerId required");
        sendResponse(ws, { id: message.id, success: true, data: service.markSeen(kind, p.ownerId) });
        return;
      }
      case "notifications:resolve": {
        if (typeof p.key !== "string") throw new Error("key required");
        sendResponse(ws, { id: message.id, success: true, data: service.resolve(p.key) });
        return;
      }
      default:
        sendError(ws, message.id, `Unknown notifications message: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error instanceof Error ? error : String(error));
  }
}
