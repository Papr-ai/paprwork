/**
 * FocusPeek — the rail logo's hover card. One job: "am I working on what matters?"
 * The next step, your three goals with the evidence behind each, and how much of this week
 * went to them. Pen's picks are shown as-is (quietly accepted); edits happen on the Focus page.
 * Weather lives on the Focus page, not here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayHttpBase } from "../../utils/gatewayHttpBase";
import { RailIcons } from "./railIcons";
import "./FocusPeek.css";

interface FocusGoalLite {
  id: string;
  title: string;
  target?: string;
  due?: string;
  why: string;
  signals?: { hours7?: number };
}

interface FocusStateLite {
  three: FocusGoalLite[];
  alignedPct: number | null;
  next: { title: string; goalId: string; due?: string } | null;
}

const REFRESH_MS = 60_000;

function fmtDue(due?: string): string {
  if (!due) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T12:00` : due);
  return Number.isNaN(d.getTime()) ? `by ${due}` : `by ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function useFocusState() {
  const [state, setState] = useState<FocusStateLite | null>(null);
  const lastFetch = useRef(0);
  const refresh = useCallback(async (force = false) => {
    if (!force && Date.now() - lastFetch.current < REFRESH_MS) return;
    lastFetch.current = Date.now();
    try {
      const res = await fetch(`${getGatewayHttpBase()}/api/workspace/focus`);
      if (res.ok) setState((await res.json()) as FocusStateLite);
      else setState((prev) => prev ?? { three: [], alignedPct: null, next: null });
    } catch {
      /* gateway restarting — keep the last good state */
    }
  }, []);
  useEffect(() => {
    void refresh(true);
  }, [refresh]);
  return { state, refresh };
}

interface FocusPeekProps {
  status: React.ReactNode;
  onOpen: () => void;
}

export function FocusPeek({ status, onOpen }: FocusPeekProps) {
  const { state, refresh } = useFocusState();
  const three = state?.three ?? [];
  return (
    <div className="focus-peek" onMouseEnter={() => void refresh()} onFocus={() => void refresh()}>
      <header className="rail-peek__header">
        <b>Focus</b>
        <span>{status}</span>
      </header>
      {state?.next ? (
        <button type="button" className="focus-peek__next" onClick={onOpen} role="menuitem">
          <small>Next</small>
          <span>{state.next.title}</span>
        </button>
      ) : null}
      {three.length ? (
        <ol className="focus-peek__three">
          {three.map((g, i) => (
            <li key={g.id}>
              <button type="button" onClick={onOpen} role="menuitem">
                <i>{i + 1}</i>
                <span className="focus-peek__goal">
                  <b>{g.title}</b>
                  <em>{[g.target, fmtDue(g.due)].filter(Boolean).join(" · ") || g.why}</em>
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rail-peek__empty">{state ? "No goals yet. Open Focus and Pen will draft them." : "Loading your three…"}</p>
      )}
      <footer className="rail-peek__footer focus-peek__foot">
        {state?.alignedPct != null ? (
          <span className="focus-peek__aligned">
            <i style={{ width: `${Math.min(100, state.alignedPct)}%` }} />
            <b>{state.alignedPct}%</b> of this week on these
          </span>
        ) : null}
        <button type="button" onClick={onOpen}>
          Open Focus
          <RailIcons.arrow />
        </button>
      </footer>
    </div>
  );
}
