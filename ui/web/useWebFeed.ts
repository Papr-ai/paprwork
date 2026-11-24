/**
 * Needs you + Waiting on for apps.papr.ai: mentions straight from the server (/focus-api/feed).
 * No desktop notices, Pen drafts or chat cards here: asks of you get a reply box you fill in;
 * Later / Mute / Turn off are desktop settings, so the menu offers notification settings in the app.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { promiseLabel } from "../../src/core/collab/promised";
import type { FocusAck, FocusFeed } from "../components/Focus/focusBridge";
import { openInDesktop } from "./desktop";
import { toFeedAsk } from "../components/Focus/page/asks";

interface Ask { id: string; fromName: string; title: string; text: string; due: string | null; promisedAt: string | null; took: boolean; chatTitle: string | null; triage?: Record<string, unknown> | null; at?: string }
type Waiting = FocusFeed["waiting"][number] extends infer W ? Omit<W, "promised" | "late"> : never;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/focus-api${path}`, body === undefined ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function buildWebFeed(asks: Ask[], waiting: Waiting[]): FocusFeed {
  const people = [...new Set([...asks.map((a) => a.fromName), ...waiting.map((w) => w.toName)].filter(Boolean))];
  return {
    needs: asks.map((a) => ({
      key: `mention:${a.id}`, goal: undefined, urgent: false, title: a.title, body: a.text, from: a.fromName,
      reason: "Asked of you", action: "Reply",
      menu: { source: "Mentions", type: "mentions", focus: false, laterWhen: "" },
      mention: { itemId: a.id, ready: true, took: a.took, draft: "",
        when: a.took && a.promisedAt ? `you said ${promiseLabel(a.promisedAt)}` : a.due ? `due ${a.due}` : "" },
    })),
    asks: asks.map((a) => toFeedAsk(a as unknown as Record<string, unknown>)),
    later: [], muted: [], people, avatars: {},
    waiting: waiting.map((w) => ({ ...w, promised: w.promisedAt ? promiseLabel(w.promisedAt) : null, late: !!w.promisedAt && Date.parse(w.promisedAt) < Date.now() })),
  };
}

export function useWebFeed() {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  // Reply on an "Also needs you" card brings it up top, where the reply box is.
  const [top, setTop] = useState<string | null>(null);
  const load = useCallback(() => void api<{ asks: Ask[]; waiting: Waiting[] }>("/feed")
    .then((d) => { setAsks(d.asks); setWaiting(d.waiting); }).catch(() => {}), []);
  useEffect(() => {
    load();
    const on = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [load]);
  const feed = useMemo(() => {
    const first = asks.find((a) => a.id === top);
    return buildWebFeed(first ? [first, ...asks.filter((a) => a !== first)] : asks, waiting);
  }, [asks, waiting, top]);

  const run = useCallback(async (op: string, a: Record<string, unknown>): Promise<FocusAck> => {
    try {
      switch (op) {
        case "answer": await api("/feed/answer", { itemId: a.itemId, status: a.status, reply: a.reply }); load(); return { ok: true };
        case "followup": await api("/feed/followup", { itemId: a.itemId, kind: a.kind, text: a.text }); load();
          return { ok: true, toast: a.kind === "nudge" ? { text: `Nudged ${String(a.name ?? "")}`.trim() } : undefined };
        case "open": {
          const id = String(a.key ?? "").replace(/^mention:/, "");
          if (id && id !== top && asks.some((x) => x.id === id)) { setTop(id); window.scrollTo({ top: 0, behavior: "smooth" }); return { ok: true }; }
          openInDesktop("Open the chat for this in Papr Work."); return { ok: true };
        }
        case "chat": openInDesktop("Open the chat for this in Papr Work."); return { ok: true };
        case "settings": openInDesktop("Open notification settings."); return { ok: true };
        default: return { ok: false, error: "Open Papr Work on your computer for this." };
      }
    } catch (e) { return { ok: false, error: (e as Error).message || "Couldn't send. Try again." }; }
  }, [load, asks, top]);
  return { feed, run };
}
