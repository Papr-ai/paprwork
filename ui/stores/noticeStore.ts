/**
 * Open notices from the gateway's notices table (chat done, approvals, ...).
 * The gateway pushes the full open list on every change ("notifications:changed");
 * we also fetch it on (re)connect. Every dot reads from here.
 *
 * We tell the gateway what's on screen (active tab or both halves of a split, and
 * whether the window is in front) so it marks those seen and skips FYI on them.
 */
import { create } from "zustand";
import { gateway } from "../src/lib/gateway";
import { useTabStore } from "./tabStore";
import type { Notice, NoticeMark } from "../../src/core/types/notices";
import { NOTICES_CHANGED_EVENT, strongestMark } from "../../src/core/types/notices";

interface NoticeState {
  notices: Notice[];
  setNotices: (notices: Notice[]) => void;
}

export const useNoticeStore = create<NoticeState>((set) => ({
  notices: [],
  setNotices: (notices) => set({ notices }),
}));

/** Strongest open mark per chat id, as a stable "id:mark|id:mark" key for selectors. */
export function chatMarksKey(s: NoticeState): string {
  const byChat = new Map<string, NoticeMark[]>();
  for (const n of s.notices) {
    if (n.owner.kind !== "chat") continue;
    const list = byChat.get(n.owner.id) ?? [];
    list.push(n.mark);
    byChat.set(n.owner.id, list);
  }
  return [...byChat.entries()]
    .map(([id, marks]) => `${id}:${strongestMark(marks)}`)
    .sort()
    .join("|");
}

export function parseMarksKey(key: string): Map<string, NoticeMark> {
  const out = new Map<string, NoticeMark>();
  if (!key) return out;
  for (const part of key.split("|")) {
    const i = part.lastIndexOf(":");
    out.set(part.slice(0, i), part.slice(i + 1) as NoticeMark);
  }
  return out;
}

/**
 * Chat ids on screen right now. A split is a parent tab (the left half, itself a chat or
 * app) plus its child tabs, so both the parent and every child count as on screen.
 */
export function visibleChatIds(): string[] {
  const { tabs, activeTabId } = useTabStore.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active) return [];
  const kids = (active.childTabIds ?? []).map((id) => tabs.find((t) => t.id === id)).filter((t) => !!t);
  return [active, ...kids].filter((t) => t.type === "chat" && t.entityId).map((t) => t.entityId);
}

let lastViewing = "";

function reportViewing(): void {
  const owners = visibleChatIds().map((id) => ({ kind: "chat", id }));
  const foreground = document.hasFocus() && document.visibilityState === "visible";
  const sig = JSON.stringify({ owners, foreground });
  if (sig === lastViewing || !gateway.isConnected()) return;
  lastViewing = sig;
  void gateway.send("notifications:viewing", { owners, foreground }).catch(() => {
    lastViewing = "";
  });
}

/**
 * Safety net: an open event on a chat that's on screen while the window is in front gets
 * marked seen. The tab hides its dot whenever it's active, so if "seen" ever misses a case
 * (a reply landing as you switch back, a reconnect), the rail would keep a dot the tab
 * dropped. This makes the two always agree.
 */
function reconcileSeen(notices: Notice[]): void {
  if (!document.hasFocus() || document.visibilityState !== "visible" || !gateway.isConnected()) return;
  const onScreen = new Set(visibleChatIds());
  const stale = new Set(notices.filter((n) => n.owner.kind === "chat" && n.type === "event" && onScreen.has(n.owner.id)).map((n) => n.owner.id));
  for (const id of stale) void gateway.send("notifications:seen", { ownerKind: "chat", ownerId: id }).catch(() => {});
}

async function refresh(): Promise<void> {
  try {
    const res = await gateway.send("notifications:list");
    if (res.success && Array.isArray(res.data)) {
      useNoticeStore.getState().setNotices(res.data as Notice[]);
      reconcileSeen(res.data as Notice[]);
    }
  } catch {
    /* gateway not ready; the next connect or broadcast fills it */
  }
}

/** Call once at app root. */
export function initNoticeListener(): void {
  window.addEventListener("gateway-broadcast", (event: Event) => {
    const { type, data } = (event as CustomEvent<{ type?: string; data?: { notices?: Notice[] } }>).detail ?? {};
    if (type === NOTICES_CHANGED_EVENT && Array.isArray(data?.notices)) {
      useNoticeStore.getState().setNotices(data.notices);
      reconcileSeen(data.notices);
    }
  });
  gateway.onConnectionChange((connected) => {
    if (!connected) return;
    lastViewing = "";
    reportViewing();
    void refresh();
  });
  useTabStore.subscribe((s, prev) => {
    if (s.activeTabId !== prev.activeTabId || s.tabs !== prev.tabs) reportViewing();
  });
  const recheck = () => { reportViewing(); reconcileSeen(useNoticeStore.getState().notices); };
  // Clicking or typing anywhere means you're here, even if no window focus event fired.
  window.addEventListener("pointerdown", recheck, true);
  window.addEventListener("keydown", recheck, true);
  window.addEventListener("focus", recheck);
  window.addEventListener("blur", reportViewing);
  // Coming back from another app by clicking straight into a mini-app (an iframe) fires no
  // focus event on this window, so "in front" would stay false and nothing gets marked seen.
  // Check focus once a second; it only talks to the gateway when the answer changes.
  window.setInterval(recheck, 1000);
  document.addEventListener("visibilitychange", recheck);
}
