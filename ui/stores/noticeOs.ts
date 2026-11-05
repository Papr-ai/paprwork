/**
 * OS notifications for notices. The gateway's route() decides whether a notice pops the OS
 * (only when Paprwork is in the background, deduped by key, capped per source); this file just
 * shows what it decided and opens the right place when you click it.
 *
 * Also feeds two senders into notify() that used to call the OS directly:
 * - update downloaded  -> app.update_ready condition (cleared when the update is gone)
 * - mini-app notification.show -> notifications:app (that app is the source, capped at Priority)
 */
import { gateway } from "../src/lib/gateway";
import { useTabStore } from "./tabStore";
import { ensureSettingsTab } from "../lib/ensureSettingsTab";
import { openJobInJobsTab } from "./jobNavigationStore";
import { NOTICES_CHANGED_EVENT, type Notice, type NoticeOwner } from "../../src/core/types/notices";
import type { SettingsTab } from "../types/settings";

/** Proposal / connection notices land on these Settings sections. */
const SECTION_EVENT: Record<string, string> = { "connections-requests": "papr:connections-show-requests" };

/** Settings sections an account notice can land on. */
const ACCOUNT_SECTIONS = new Set<string>(["billing", "connections", "connections-requests", "team", "keys", "notifications", "cloud", "profile"]);

/**
 * Where an account notice opens. Cloud notices (member requests, connection requests) carry
 * owner.id ("billing", "connections") but no section, so fall back to the id instead of
 * landing on the Settings default (Profile). Connection requests go to the Requests list.
 */
export function accountSection(owner: NoticeOwner, key?: string): string | undefined {
  if (owner.section) return owner.section;
  if (owner.id === "connections" && key?.startsWith("connection:")) return "connections-requests";
  return ACCOUNT_SECTIONS.has(owner.id) ? owner.id : undefined;
}

export function openNoticeOwner(owner: NoticeOwner | undefined, key?: string): void {
  // Clicking it is seeing it, wherever you land.
  if (key) void gateway.send("notifications:clicked", { key }).catch(() => {});
  if (!owner) return;
  const { tabs, createTab, switchToTab } = useTabStore.getState();
  if (owner.kind === "app" && owner.id.startsWith("job:")) {
    openJobInJobsTab(owner.id.slice(4));
    return;
  }
  if (owner.kind === "chat" || owner.kind === "app") {
    const existing = tabs.find((t) => t.type === owner.kind && t.entityId === owner.id);
    switchToTab(existing?.id ?? createTab(owner.kind, owner.id, owner.name));
    return;
  }
  const target = accountSection(owner, key);
  const section = target === "connections-requests" ? "connections" : target;
  ensureSettingsTab(section ? { section: section as SettingsTab } : undefined);
  const evt = target ? SECTION_EVENT[target] : undefined;
  if (evt) window.setTimeout(() => window.dispatchEvent(new CustomEvent(evt)), 50);
}

/** Keys with an OS notification still on screen (or in Notification Center). */
const shownKeys = new Set<string>();

function showOs(notice: Notice, sound?: boolean, previews?: string): void {
  const show = window.electronAPI?.notices?.showOs;
  if (!show) return;
  shownKeys.add(notice.key);
  void show({ key: notice.key, title: notice.title, body: notice.body ?? "", level: notice.level, sound, previews, owner: notice.owner }).catch(() => {});
}

/** Seen in the app, answered or fixed: take its OS notification away too. */
function closeSeen(open: Notice[]): void {
  const close = window.electronAPI?.notices?.closeOs;
  if (!close || !shownKeys.size) return;
  const stillNew = new Set(open.filter((n) => !n.seenAt).map((n) => n.key));
  const gone = [...shownKeys].filter((k) => !stillNew.has(k));
  if (!gone.length) return;
  for (const k of gone) shownKeys.delete(k);
  void close(gone).catch(() => {});
}

let lastUpdateSent = "";
function reportUpdate(status: { status?: string; version?: string } | null | undefined): void {
  const ready = status?.status === "ready" && !!status.version;
  const sig = ready ? `ready:${status?.version}` : "none";
  if (sig === lastUpdateSent || !gateway.isConnected()) return;
  lastUpdateSent = sig;
  void gateway.send("notifications:update", { ready, version: status?.version }).catch(() => { lastUpdateSent = ""; });
}

/** A mini-app asked for an OS notification. Goes through notify() like everything else. */
export function noticeFromApp(appId: string, appName: string, opts: { title?: unknown; body?: unknown; tag?: unknown }): Promise<unknown> {
  if (typeof opts?.title !== "string" || !opts.title.trim()) return Promise.resolve({ success: false });
  return gateway
    .send("notifications:app", { appId, appName, title: opts.title, body: opts.body, tag: opts.tag })
    .then(() => ({ success: true }));
}

/** Call once at app root. */
export function initNoticeOs(): void {
  window.addEventListener("gateway-broadcast", (event: Event) => {
    const { type, data } = (event as CustomEvent<{ type?: string; data?: { notice?: Notice; notices?: Notice[]; sound?: boolean; previews?: string } }>).detail ?? {};
    if (type === "notifications:os" && data?.notice) showOs(data.notice, data.sound, data.previews);
    if (type === NOTICES_CHANGED_EVENT && Array.isArray(data?.notices)) closeSeen(data.notices);
  });
  window.addEventListener("papr-notice-open", (event: Event) => {
    const d = (event as CustomEvent<{ key?: string; owner?: NoticeOwner }>).detail;
    openNoticeOwner(d?.owner, d?.key);
  });
  const updater = window.electronAPI?.updater;
  if (updater) {
    updater.onStatus((s) => reportUpdate(s));
    gateway.onConnectionChange((connected) => {
      if (!connected) return;
      lastUpdateSent = "";
      void updater.getStatus?.().then(reportUpdate).catch(() => {});
    });
  }
}
