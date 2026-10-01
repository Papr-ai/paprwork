/**
 * FocusPeek — the rail logo's hover card. One job: a one-glance answer to "is my time going to
 * what matters?" Header: is my agent working. Body: your three, one line each, with this week's
 * hours. Footer: share of the week on these + Open Focus. Each row opens that goal; the next step,
 * evidence and targets live on the Focus page (and in each row's tooltip), not here.
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

/** A goal name you can read in one glance: first clause, at most ~28 characters on a word boundary. */
export function shortTitle(title: string, max = 28): string {
  const clause = title.split(/\s+(?:and|for|on|with|by|to)\s+|[,:;—–]/i)[0].trim() || title;
  if (clause.length <= max) return clause;
  const words = clause.split(/\s+/);
  let out = words[0];
  for (const w of words.slice(1)) {
    if (`${out} ${w}`.length > max) break;
    out = `${out} ${w}`;
  }
  return out;
}

export type FocusPace = "on" | "risk" | "off";

/** Same read as the Home dashboard: 1h+ this week moved it, some time barely touched it, none is cold. */
export function paceOf(hours?: number): FocusPace {
  return !hours || hours <= 0 ? "off" : hours >= 1 ? "on" : "risk";
}

/** Hours this week, glanceable: "7.6h", "<1h" or "—" when nothing touched it yet. */
export function fmtHours(h?: number): string {
  if (!h || h <= 0) return "—";
  return h < 1 ? "<1h" : `${Math.round(h * 10) / 10}h`;
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
  /** Open Focus; with a goal id, Home opens that goal's detail view. */
  onOpen: (goalId?: string) => void;
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
      {three.length ? (
        <ul className="focus-peek__three">
          {three.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => onOpen(g.id)}
                role="menuitem"
                title={[g.title, g.target, fmtDue(g.due), g.why].filter(Boolean).join(" · ")}
              >
                <span className="focus-peek__title">{shortTitle(g.title)}</span>
                <span
                  className={`focus-peek__meter is-${paceOf(g.signals?.hours7)}`}
                  role="img"
                  aria-label={`${fmtHours(g.signals?.hours7)} this week`}
                >
                  <i style={{ width: `${Math.round(Math.min(1, (g.signals?.hours7 ?? 0) / 5) * 100)}%` }} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rail-peek__empty">{state ? "No goals yet. Open Focus and Pen will draft them." : "Loading your three…"}</p>
      )}
      <footer className="rail-peek__footer focus-peek__foot">
        {state?.alignedPct != null ? (
          <span className="focus-peek__aligned" title="Share of this week's tracked work that touched these three">
            <b>{state.alignedPct}%</b> of this week
          </span>
        ) : (
          <span />
        )}
        <button type="button" onClick={() => onOpen()}>
          Open Focus
          <RailIcons.arrow />
        </button>
      </footer>
    </div>
  );
}

/**
 * Ask the Home mini-app to open one goal. Home lives in a cross-origin iframe, so post to every
 * iframe (only Home listens for this type) and retry briefly while a freshly-shown Home loads.
 */
export function openFocusGoal(goalId: string): void {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const post = () =>
    document.querySelectorAll("iframe").forEach((f) => {
      try {
        f.contentWindow?.postMessage({ type: "papr-focus-open", goalId, nonce }, "*");
      } catch {
        /* detached frame */
      }
    });
  [0, 300, 900, 2000].forEach((ms) => window.setTimeout(post, ms));
}
