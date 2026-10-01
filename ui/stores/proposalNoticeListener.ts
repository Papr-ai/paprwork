/**
 * OS notifications for proposal updates from another machine (accepted,
 * declined, needs update, new proposal). The gateway polls the server feed
 * each heartbeat and broadcasts `cloud-proposal:notify`; the share bar and
 * inbox refresh themselves from the accompanying stale broadcasts.
 */

interface ProposalNotice {
  title: string;
  body: string;
}

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
      }).catch(() => {});
    }
  });
}
