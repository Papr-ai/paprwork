/**
 * OS notifications for proposal updates from another machine (accepted,
 * declined, needs update, new proposal). The gateway polls the server feed
 * each heartbeat and broadcasts `cloud-proposal:notify`; the share bar and
 * inbox refresh themselves from the accompanying stale broadcasts.
 */

import { ensureSettingsTab } from "../lib/ensureSettingsTab";

interface ProposalNotice {
  title: string;
  body: string;
  openSettings?: "connections" | "connections-requests";
}

/** "connections-requests" lands admins on the Requests list inside Connections. */
export const CONNECTIONS_REQUESTS_EVENT = "papr:connections-show-requests";

let initialized = false;

export function initProposalNoticeListener(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener("gateway-broadcast", (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { type?: string; data?: { notices?: ProposalNotice[] } }
      | undefined;
    if (detail?.type !== "cloud-proposal:notify") return;
    const invoke = window.electronAPI?.system?.invoke;
    if (!invoke) return;
    for (const notice of detail.data?.notices ?? []) {
      if (!notice?.title) continue;
      void invoke("notification.show", {
        title: notice.title,
        body: notice.body ?? "",
        ...(notice.openSettings ? { openSettings: notice.openSettings } : {}),
      }).catch(() => {});
    }
  });
  window.addEventListener("papr-notification-open-settings", (event: Event) => {
    const target = (event as CustomEvent<{ target?: string }>).detail?.target;
    if (target !== "connections" && target !== "connections-requests") return;
    ensureSettingsTab({ section: "connections" });
    if (target === "connections-requests") {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(CONNECTIONS_REQUESTS_EVENT)), 50);
    }
  });
}
