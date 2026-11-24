/**
 * Deep links from notifications into Settings (Connections, Billing).
 * Proposal updates from another machine are notices now: the gateway calls notify()
 * and route() decides the OS pop (see noticeOs.ts), so nothing here shows the OS.
 */

import { ensureSettingsTab } from "../lib/ensureSettingsTab";
import { savePendingPlan } from "../utils/pendingPlan";

/** "connections-requests" lands admins on the Requests list inside Connections. */
export const CONNECTIONS_REQUESTS_EVENT = "papr:connections-show-requests";

let initialized = false;

export function initProposalNoticeListener(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener("papr-notification-open-settings", (event: Event) => {
    const detail = (event as CustomEvent<{ target?: string; plan?: string; track?: string }>).detail;
    const target = detail?.target;
    // papr://billing deep link (post-checkout page, or a plan button on papr.ai/pricing)
    // lands on the plan card; a plan in the link becomes a "Continue to checkout" prompt.
    if (target === "billing") {
      if (detail?.plan) savePendingPlan({ plan: detail.plan, track: detail.track });
      ensureSettingsTab({ section: "billing", focusPlan: true });
      return;
    }
    if (target !== "connections" && target !== "connections-requests") return;
    ensureSettingsTab({ section: "connections" });
    if (target === "connections-requests") {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(CONNECTIONS_REQUESTS_EVENT)), 50);
    }
  });
}
