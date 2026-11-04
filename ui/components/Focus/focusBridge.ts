/**
 * Needs you + Waiting on live inside the Home brief (same page, same type and spacing as Your three).
 * This hook is the native half: it builds the feed from the notice store and the mention cards, posts it
 * to the Home iframe (`papr-focus-feed`), and runs what the brief asks for (`papr-focus-act` → ack).
 * Only the ops below are accepted, and only from an iframe inside the Focus view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Notice } from "../../../src/core/types/notices";
import { hasFocusMode, isUrgent, laterUntil, muteEndLabel, noticeLabels, whenLabel } from "../../../src/core/notifications/needsYou";
import { sourceDef } from "../../../src/core/notifications/sources";
import { promiseLabel } from "../../../src/core/collab/promised";
import { gateway } from "../../src/lib/gateway";
import { openNoticeOwner } from "../../stores/noticeOs";
import { ensureSettingsTab } from "../../lib/ensureSettingsTab";
import { useTabStore } from "../../stores/tabStore";
import { bringBack, muteSource, putOff, setFocusMode, turnOffType, unmuteSource, useNeedsYou } from "../../stores/useNeedsYou";

interface Card { itemId: string; fromName: string; text: string; suggestedReply: string; action: { title: string; due?: string | null } | null; status: string; sentReply?: string; promisedAt?: string | null }
interface Waiting { id: string; toName: string; title: string; due: string | null; state: "asked" | "in_progress"; reply: string | null; replyAt: string | null; promisedAt: string | null; mine: { text: string; at: string } | null; nudgedAt: string | null; chatId: string | null; chatTitle: string | null; at: string }
type Ack = { ok: boolean; error?: string; toast?: { text: string; undo?: { op: string; args: Record<string, unknown> } } };

const mentionId = (n: Notice) => (n.kind === "mention" && n.key.startsWith("mention:") ? n.key.slice(8) : null);
const err = (r: { success: boolean; error?: unknown }) => (typeof r.error === "string" ? r.error : "Couldn't send. Try again.");

function item(n: Notice, reason: string, card: Card | undefined) {
  const l = noticeLabels(n);
  const id = mentionId(n);
  const took = !!card?.sentReply && card.status === "open";
  return {
    key: n.key, urgent: isUrgent(n), title: card?.action?.title ?? n.title, body: card ? card.text : n.body ?? "",
    from: card?.fromName ?? n.owner.name, reason, action: (n.actions ?? []).find((a) => a.intent !== "open")?.label ?? n.actions?.[0]?.label ?? "Open",
    menu: { source: l.source, type: l.type, focus: hasFocusMode(l.sourceId), laterWhen: whenLabel(laterUntil()) },
    mention: id ? { itemId: id, ready: !!card, took, draft: card?.suggestedReply ?? "",
      when: took && card?.promisedAt ? `you said ${promiseLabel(card.promisedAt)}` : card?.action?.due ? `due ${card.action.due}` : "" } : null,
  };
}

export function useFocusBridge(root: React.RefObject<HTMLElement | null>) {
  const { needs, reasons, later, muted } = useNeedsYou();
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const ids = needs.map(mentionId).filter((x): x is string => !!x).join(",");

  const loadCard = (itemId: string) => void gateway.send("collab:card", { itemId }).then((r) => {
    const c = r.success ? (r.data as { card: Card | null }).card : null;
    if (c) setCards((m) => ({ ...m, [itemId]: c }));
  }).catch(() => {});
  const loadWaiting = () => void gateway.send("collab:waiting", {}).then((r) => setWaiting(r.success ? (r.data as { waiting: Waiting[] }).waiting : [])).catch(() => {});

  useEffect(() => { ids.split(",").filter(Boolean).forEach(loadCard); }, [ids]);
  useEffect(() => {
    loadWaiting();
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.type === "collab:mention" || d?.type === "notifications:changed") loadWaiting();
      if (d?.type === "collab:card" && d.data?.itemId) setCards((m) => ({ ...m, [d.data.itemId]: { ...m[d.data.itemId], ...d.data.card } }));
    };
    window.addEventListener("gateway-broadcast", on);
    window.addEventListener("papr-workspace-switch-complete", loadWaiting);
    return () => { window.removeEventListener("gateway-broadcast", on); window.removeEventListener("papr-workspace-switch-complete", loadWaiting); };
  }, []);

  const feed = useMemo(() => ({
    needs: needs.map((n) => item(n, reasons[n.key] ?? "", cards[mentionId(n) ?? ""])),
    later: later.map((n) => ({ key: n.key, title: n.title, when: whenLabel(n.laterUntil!) })),
    muted: muted.map((m) => ({ id: m.id, name: sourceDef(m.id)?.name ?? "This source", until: muteEndLabel(m.until) })),
    people: [...new Set([...waiting.map((w) => w.toName), ...Object.values(cards).map((c) => c.fromName)].filter(Boolean))],
    waiting: waiting.map((w) => ({ ...w, promised: w.promisedAt ? promiseLabel(w.promisedAt) : null, late: !!w.promisedAt && Date.parse(w.promisedAt) < Date.now() })),
  }), [needs, reasons, later, muted, cards, waiting]);

  const refresh = useRef(loadWaiting);
  refresh.current = loadWaiting;
  const latest = useRef(feed);
  latest.current = feed;
  const byKey = useRef(new Map<string, Notice>());
  byKey.current = new Map([...needs, ...later].map((n) => [n.key, n]));

  const frames = () => [...(root.current?.querySelectorAll("iframe") ?? [])];
  const post = (msg: unknown) => frames().forEach((f) => { try { f.contentWindow?.postMessage(msg, "*"); } catch { /* detached */ } });
  useEffect(() => { post({ type: "papr-focus-feed", feed }); }, [feed]);

  useEffect(() => {
    const run = async (op: string, a: Record<string, unknown>): Promise<Ack> => {
      const n = typeof a.key === "string" ? byKey.current.get(a.key) : undefined;
      const l = n ? noticeLabels(n) : null;
      switch (op) {
        case "open": if (n) openNoticeOwner(n.owner, n.key); return { ok: true };
        case "later": if (!n) break; await putOff(n.key); return { ok: true, toast: { text: `Back ${whenLabel(laterUntil())}`, undo: { op: "unlater", args: { key: n.key } } } };
        case "unlater": await bringBack(String(a.key)); return { ok: true };
        case "mute": { if (!l) break; const r = await muteSource(l.sourceId);
          return { ok: true, toast: { text: `${l.source} muted until ${r?.until ? muteEndLabel(r.until) : "in an hour"}`, undo: { op: "unmute", args: { sourceId: l.sourceId } } } }; }
        case "unmute": await unmuteSource(String(a.sourceId)); return { ok: true };
        case "focus": { if (!l) break; const always = a.mode === "always"; await setFocusMode(l.sourceId, always ? "always" : "never");
          return { ok: true, toast: { text: always ? `${l.source} always shows in Focus` : `${l.source} stays as dots`, undo: { op: "focus-reset", args: { sourceId: l.sourceId } } } }; }
        case "focus-reset": await setFocusMode(String(a.sourceId), "pen"); return { ok: true };
        case "turnoff": if (!l) break; await turnOffType(l.sourceId, l.typeId); return { ok: true };
        case "settings": ensureSettingsTab({ section: "notifications" }); return { ok: true };
        case "answer": {
          const r = await gateway.send("collab:answer", { itemId: a.itemId, status: a.status, reply: a.reply }).catch((e: Error) => ({ success: false, error: e.message }));
          if (r.success) loadCard(String(a.itemId));
          return r.success ? { ok: true } : { ok: false, error: err(r) };
        }
        case "followup": {
          const r = await gateway.send("collab:followup", { itemId: a.itemId, kind: a.kind, text: a.text }).catch((e: Error) => ({ success: false, error: e.message }));
          if (r.success) loadWaiting();
          return r.success ? { ok: true, toast: a.kind === "nudge" ? { text: `Nudged ${String(a.name ?? "")}`.trim() } : undefined } : { ok: false, error: err(r) };
        }
        case "chat": {
          if (typeof a.chatId !== "string") break;
          const { tabs, createTab, switchToTab } = useTabStore.getState();
          const t = tabs.find((x) => x.type === "chat" && x.entityId === a.chatId);
          switchToTab(t?.id ?? createTab("chat", a.chatId, typeof a.title === "string" ? a.title : "Chat"));
          return { ok: true };
        }
      }
      return { ok: false, error: "That item is gone. Refresh Focus." };
    };
    const onMsg = (e: MessageEvent) => {
      const m = e.data as { type?: string; id?: string; op?: string; args?: Record<string, unknown> } | null;
      if (!m?.type?.startsWith("papr-focus-") || !frames().some((f) => f.contentWindow === e.source)) return;
      const reply = (x: unknown) => (e.source as Window | null)?.postMessage(x, "*");
      // The brief (re)loaded = Focus opened: send what we have, and refresh Waiting on (a cold server can miss the first load).
      if (m.type === "papr-focus-ready") { reply({ type: "papr-focus-feed", feed: latest.current }); refresh.current(); }
      if (m.type === "papr-focus-act" && m.op) void run(m.op, m.args ?? {}).catch((x: Error) => ({ ok: false, error: x.message })).then((ack) => reply({ type: "papr-focus-ack", id: m.id, ...ack }));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
}
