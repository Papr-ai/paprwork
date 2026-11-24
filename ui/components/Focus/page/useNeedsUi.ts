/**
 * Needs you / Waiting on UI state: which item is busy, inline errors, reply drafts, and the undo toast.
 * Wraps the feed's run() the way needs_wire.js did.
 */
import { useCallback, useRef, useState } from "react";
import type { FeedItem, FocusAck } from "../focusBridge";
import type { FocusGoal } from "./focusApi";
import type { NeedsUi } from "./NeedsSection";

export type Toast = { text: string; undo?: { op: string; args: Record<string, unknown> } } | null;

export function useNeedsUi(run: (op: string, args: Record<string, unknown>) => Promise<FocusAck>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<Toast>(null);
  const timer = useRef<number | undefined>(undefined);

  const flash = useCallback((t: Toast) => {
    setToast(t);
    window.clearTimeout(timer.current);
    if (t) timer.current = window.setTimeout(() => setToast((c) => (c === t ? null : c)), 6000);
  }, []);

  const runOp = useCallback<NeedsUi["run"]>(async (key, op, args, after) => {
    setBusy(key);
    setErrors(({ [key]: _, ...rest }) => rest);
    const r = await run(op, args).catch((e: Error) => ({ ok: false, error: e.message }) as FocusAck);
    setBusy(null);
    if (!r.ok) setErrors((m) => ({ ...m, [key]: r.error || "Couldn't send. Try again." }));
    else after?.();
    if (r.toast) flash(r.toast);
  }, [run, flash]);

  const undo = useCallback(() => {
    const u = toast?.undo;
    setToast(null);
    if (u) void run(u.op, u.args);
  }, [toast, run]);

  const ui: NeedsUi = { run: runOp, busy, errors, drafts, setDraft: (id, v) => setDrafts((d) => ({ ...d, [id]: v })) };
  return { ui, toast, undo };
}

/**
 * Which of Your three an item moves. Papr Work asks Jev (item.goal: title, or null = none);
 * until it answers, shared words between the item and a goal title.
 */
export function goalFor(i: FeedItem, three: FocusGoal[]): string {
  if (i.goal !== undefined) return i.goal || "";
  const stop = new Set(["the", "and", "for", "with", "your", "from", "this", "that", "open", "page", "update", "awaiting"]);
  const words = (t: string) => String(t || "").toLowerCase().replace(/^g\d+\s+/, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !stop.has(w)).map((w) => w.replace(/s$/, ""));
  const have = new Set(words(`${i.title} ${i.body}`));
  let best: FocusGoal | null = null, top = 0;
  for (const g of three) { const n = words(g.title).filter((w) => have.has(w)).length; if (n > top) { top = n; best = g; } }
  return best ? String(best.title).replace(/^G\d+\s+/, "") : "";
}
