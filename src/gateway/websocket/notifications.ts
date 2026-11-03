/**
 * notifications:* — the UI reads and clears notices.
 *   notifications:list     → open notices
 *   notifications:snapshot → open notices + your settings (Focus › Needs you, the count on Pen)
 *   notifications:later / unlater   → put one off until 3 PM / 9 AM tomorrow, or bring it back
 *   notifications:mute / unmute     → mute a source for an hour, or undo it
 *   notifications:viewing  → what's on screen (marks it seen, suppresses FYI on it)
 *   notifications:seen     → you looked at a thing
 *   notifications:resolve  → clear one notice by key (e.g. "Not now" on a request)
 *   notifications:app      → a mini-app's notification.show (source = that app, capped at Priority)
 *   notifications:update   → update downloaded (ready) or gone (anything else); a platform condition
 *   notifications:clicked  → you clicked its OS notification (events done, conditions seen)
 *   notifications:center / set-prefs / reset-prefs → Settings → Notifications
 *   notifications:stats    → how much reached you in the last N days (counts only)
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
      case "notifications:snapshot":
        sendResponse(ws, { id: message.id, success: true, data: service.snapshot() });
        return;
      case "notifications:later":
      case "notifications:unlater": {
        if (typeof p.key !== "string" || !p.key) throw new Error("key required");
        const data = message.type === "notifications:later" ? { until: service.later(p.key) } : { ok: service.unlater(p.key) };
        sendResponse(ws, { id: message.id, success: true, data });
        return;
      }
      case "notifications:mute":
      case "notifications:unmute": {
        if (typeof p.sourceId !== "string" || !p.sourceId) throw new Error("sourceId required");
        if (message.type === "notifications:mute") sendResponse(ws, { id: message.id, success: true, data: { until: service.muteSource(p.sourceId) } });
        else { service.unmuteSource(p.sourceId); sendResponse(ws, { id: message.id, success: true, data: { ok: true } }); }
        return;
      }
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
      case "notifications:app": {
        if (typeof p.appId !== "string" || !p.appId || typeof p.title !== "string") throw new Error("appId and title required");
        const name = typeof p.appName === "string" && p.appName ? p.appName : "Mini-app";
        const body = typeof p.body === "string" ? p.body.slice(0, 500) : undefined;
        const n = service.notify({
          key: `app:${p.appId}:${typeof p.tag === "string" && p.tag ? p.tag : p.title}`, kind: "app.notification", type: "event",
          // The app's own explicit call is "for you"; Priority is the most an app can send.
          level: "priority", forYou: true, title: p.title.slice(0, 200), ...(body ? { body } : {}),
          source: { type: "app", id: p.appId, name }, owner: { kind: "app", id: p.appId, name },
          actions: [{ label: "Open", intent: "open" }],
        });
        sendResponse(ws, { id: message.id, success: true, data: { stored: !!n } });
        return;
      }
      case "notifications:update": {
        if (p.ready === true && typeof p.version === "string") {
          service.notify({
            key: "app.update_ready", kind: "app.update_ready", type: "condition", level: "priority",
            title: "Papr Work update ready", body: `Version ${p.version} is downloaded. Restart to update.`,
            source: { type: "platform", id: "updater", name: "Papr Work" },
            owner: { kind: "account", id: "settings", name: "About", section: "about" },
            actions: [{ label: "Restart", intent: "update.install" }],
          });
        } else service.resolve("app.update_ready");
        sendResponse(ws, { id: message.id, success: true });
        return;
      }
      case "notifications:clicked": {
        if (typeof p.key !== "string" || !p.key) throw new Error("key required");
        sendResponse(ws, { id: message.id, success: true, data: service.markSeenKey(p.key) });
        return;
      }
      case "notifications:center":
        sendResponse(ws, { id: message.id, success: true, data: service.center() });
        return;
      case "notifications:stats": {
        const days = typeof p.days === "number" && p.days >= 1 && p.days <= 90 ? Math.floor(p.days) : 7;
        sendResponse(ws, { id: message.id, success: true, data: service.statsSummary(days) });
        return;
      }
      case "notifications:set-prefs":
        sendResponse(ws, { id: message.id, success: true, data: service.setPrefs(p.prefs) });
        return;
      case "notifications:reset-prefs":
        sendResponse(ws, { id: message.id, success: true, data: service.resetPrefs() });
        return;
      case "notifications:resolve": {
        // { group } clears every notice in it, e.g. "key:NAME" once that key exists.
        if (typeof p.group === "string") { sendResponse(ws, { id: message.id, success: true, data: service.resolveGroup(p.group) }); return; }
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
