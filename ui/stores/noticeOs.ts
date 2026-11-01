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
import type { Notice, NoticeOwner } from "../../src/core/types/notices";
import type { SettingsTab } from "../types/settings";

/** Proposal / connection notices land on these Settings sections. */
const SECTION_EVENT: Record<string, string> = { "connections-requests": "papr:connections-show-requests" };

export function openNoticeOwner(owner: NoticeOwner | undefined): void {
  if (!owner) return;
  const { tabs, createTab, switchToTab } = useTabStore.getState();
  if (owner.kind === "chat" || owner.kind === "app") {
    const id = owner.kind === "app" && owner.id.startsWith("job:") ? null : owner.id;
    if (!id) return;
    const existing = tabs.find((t) => t.type === owner.kind && t.entityId === id);
    switchToTab(existing?.id ?? createTab(owner.kind, id, owner.name));
    return;
  }
  const section = owner.section === "connections-requests" ? "connections" : owner.section;
  ensureSettingsTab(section ? { section: section as SettingsTab } : undefined);
  const evt = owner.section ? SECTION_EVENT[owner.section] : undefined;
  if (evt) window.setTimeout(() => window.dispatchEvent(new CustomEvent(evt)), 50);
}

function showOs(notice: Notice): void {
  const show = window.electronAPI?.notices?.showOs;
  if (!show) return;
  void show({ title: notice.title, body: notice.body ?? "", level: notice.level, owner: notice.owner }).catch(() => {});
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
    const { type, data } = (event as CustomEvent<{ type?: string; data?: { notice?: Notice } }>).detail ?? {};
    if (type === "notifications:os" && data?.notice) showOs(data.notice);
  });
  window.addEventListener("papr-notice-open", (event: Event) => {
    openNoticeOwner((event as CustomEvent<{ owner?: NoticeOwner }>).detail?.owner);
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
