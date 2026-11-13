/**
 * One root cause, one notice. When something underneath is broken, raise one condition and let every
 * feature error it causes fold into it. Each clears itself when fixed.
 *
 *   net.offline          ambient: Pen's icon + Focus's top line, every dot gray. No pop.
 *   account.connectors   Priority: N connected accounts need you to sign in again (generic, not per account).
 *   account.credits      Urgent: AI credits ran out. Pen leans out. Clears on the next finished reply.
 *   account.plan         Urgent: Papr Cloud paused (plan limit or subscription). Clears when billing is back.
 */
import { tryListOpen, tryNotify, tryResolve } from "./NoticeService.js";

const serverSaysOut = () => tryListOpen().some((n) => n.kind === "billing.credits_out");
/** The server already said Papr Cloud stopped (members: cloud_paused; admins: payment failed + plan stopped). */
const serverSaysPaused = () => tryListOpen().some((n) => n.kind === "billing.cloud_paused" || (n.kind === "billing.payment_failed" && n.level === "urgent"));

const papr = { type: "platform" as const, id: "papr", name: "Papr Work" };
const billing = { type: "billing" as const, id: "billing", name: "Billing" };

export const ROOT_KEYS = { offline: "net.offline", connectors: "account.connectors", credits: "account.credits", plan: "account.plan" } as const;

export function setOnline(online: boolean): void {
  if (online) return tryResolve(ROOT_KEYS.offline);
  tryNotify({
    key: ROOT_KEYS.offline, kind: "net.offline", type: "condition", level: "fyi", ambient: true,
    title: "You're offline", body: "Chat with cloud models, sync and connected accounts are paused. Local files and apps still work.",
    source: papr, owner: { kind: "account", id: "network", name: "Network" },
  });
}

/** names: the connected accounts whose sign-in expired. Empty clears it. */
export function setConnectorsSignedOut(names: string[]): void {
  if (!names.length) return tryResolve(ROOT_KEYS.connectors);
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  tryNotify({
    key: ROOT_KEYS.connectors, kind: "account.connectors", type: "condition", level: "priority",
    title: names.length === 1 ? `Sign in to ${names[0]} again` : `${names.length} accounts need you to sign in again`,
    body: `${list} signed you out. Pen can't use ${names.length === 1 ? "it" : "them"} until you reconnect.`,
    source: papr, owner: { kind: "account", id: "connections", name: "Connectors & API Keys", section: "connections" },
    actions: [{ label: "Reconnect", intent: "open" }],
  });
}

/** via: which service said 402. Papr's own AI service gets Papr copy; a key you added gets that provider's. */
export function creditsOut(via: "papr" | string): void {
  const ours = via === "papr";
  // The server already told you (and your admins): don't say it twice.
  if (ours && serverSaysOut()) return;
  tryNotify({
    key: ROOT_KEYS.credits, kind: "account.credits", type: "condition", level: "urgent",
    title: ours ? "You're out of AI credits" : `Your ${via} account is out of credits`,
    body: ours ? "Add credits to keep chatting with Pen. Your files and apps still work." : `Add credits in your ${via} account, or switch to another model.`,
    source: ours ? billing : papr, owner: { kind: "account", id: "billing", name: "Plan & usage", section: ours ? "billing" : "connections" },
    actions: [{ label: ours ? "Add credits" : "Switch model", intent: "open" }],
  });
}

export const creditsBack = () => tryResolve(ROOT_KEYS.credits);

export function planPaused(title: string, detail: string): void {
  if (serverSaysPaused()) return;
  tryNotify({
    key: ROOT_KEYS.plan, kind: "account.plan", type: "condition", level: "urgent", title, body: detail,
    source: billing, owner: { kind: "account", id: "billing", name: "Plan & usage", section: "billing" },
    actions: [{ label: "Plan & usage", intent: "open" }],
  });
}

export const planBack = () => tryResolve(ROOT_KEYS.plan);
