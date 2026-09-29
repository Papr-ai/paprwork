/**
 * useAgentNudge — decides *when* to ask the gateway whether a nudge is allowed.
 *
 * Only at breakpoints, never mid-task (Iqbal & Bailey, CHI 2008; Okoshi et al., Attelia 2015):
 *   - 20s after launch, once you have settled in
 *   - when you come back after ≥ 10 minutes away
 *   - 8s after your agent finishes a piece of work (a natural task boundary)
 * …and even then, only if you have not typed for 30s, no chat is working and no dialog is open.
 * The gateway still applies the daily/weekly caps, quiet hours and backoff (nudgePolicy.ts), so
 * a breakpoint is a chance to ask, never a guarantee.
 *
 * An open nudge that you do not touch parks itself as a still dot after 45s (hovering pauses that).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayHttpBase } from "../../utils/gatewayHttpBase";
import type { AgentWorkState } from "./agentWork";

export type NudgeAction = { type: "focus"; goalId?: string } | { type: "chat"; prompt: string } | { type: "app"; appId: string };

export interface AgentNudgeData {
  key: string;
  kind: string;
  line: string;
  sub?: string;
  go: string;
  later: string;
  dismiss?: string;
  action: NudgeAction;
}

export type NudgePhase = "off" | "in" | "open" | "out" | "rest";

export const NUDGE_TIMING = {
  settleMs: 20_000,
  awayMs: 10 * 60_000,
  returnPauseMs: 3_000,
  afterWorkMs: 8_000,
  typingQuietMs: 30_000,
  arriveMs: 1_500,
  leaveMs: 460,
  autoParkMs: 45_000,
} as const;

const api = (p: string) => `${getGatewayHttpBase()}/api/nudge${p}`;

function send(n: AgentNudgeData, event: "shown" | "go" | "later" | "dismiss") {
  void fetch(api("/event"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: n.key, kind: n.kind, event }),
  }).catch(() => undefined);
}

const today = () => new Date().toDateString();

export function useAgentNudge(workState: AgentWorkState, onGo: (action: NudgeAction) => void) {
  const [nudge, setNudge] = useState<AgentNudgeData | null>(null);
  const [phase, setPhaseState] = useState<NudgePhase>("off");
  const phaseRef = useRef<NudgePhase>("off");
  const nudgeRef = useRef<AgentNudgeData | null>(null);
  const workRef = useRef(workState);
  const lastKeyAt = useRef(0);
  const awaySince = useRef<number | null>(null);
  const restDay = useRef("");
  const timers = useRef<number[]>([]);
  const parkTimer = useRef(0);
  const asking = useRef(false);

  const setPhase = useCallback((p: NudgePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const park = useCallback(() => {
    window.clearTimeout(parkTimer.current);
    if (phaseRef.current !== "open" && phaseRef.current !== "in") return;
    setPhase("out");
    restDay.current = today();
    later(() => setPhase("rest"), NUDGE_TIMING.leaveMs);
  }, [setPhase]);

  const armPark = useCallback(() => {
    window.clearTimeout(parkTimer.current);
    parkTimer.current = window.setTimeout(park, NUDGE_TIMING.autoParkMs);
  }, [park]);

  const play = useCallback(
    (n: AgentNudgeData) => {
      nudgeRef.current = n;
      setNudge(n);
      setPhase("in");
      later(() => {
        setPhase("open");
        armPark();
      }, NUDGE_TIMING.arriveMs);
    },
    [armPark, setPhase],
  );

  const canInterrupt = () =>
    document.visibilityState === "visible" &&
    Date.now() - lastKeyAt.current > NUDGE_TIMING.typingQuietMs &&
    workRef.current !== "working" &&
    !document.querySelector('[aria-modal="true"]');

  const breakpoint = useCallback(async () => {
    if (phaseRef.current === "rest" && restDay.current !== today()) setPhase("off"); // yesterday's dot fades
    if (phaseRef.current !== "off" || asking.current || !canInterrupt()) return;
    asking.current = true;
    try {
      const res = await fetch(api("/next"));
      const d = res.ok ? ((await res.json()) as { nudge: AgentNudgeData | null }) : null;
      if (d?.nudge && phaseRef.current === "off" && canInterrupt()) {
        send(d.nudge, "shown");
        play(d.nudge);
      }
    } catch {
      /* gateway restarting — silence is the right default */
    } finally {
      asking.current = false;
    }
  }, [play, setPhase]);

  // Breakpoint 1: settled in after launch. Plus: typing tracker, away/return tracker, reviewer preview.
  useEffect(() => {
    const t = window.setTimeout(() => void breakpoint(), NUDGE_TIMING.settleMs);
    const onKey = () => (lastKeyAt.current = Date.now());
    const onAway = () => {
      if (document.visibilityState === "hidden" || !document.hasFocus()) awaySince.current ??= Date.now();
    };
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      const since = awaySince.current;
      awaySince.current = null;
      if (since && Date.now() - since >= NUDGE_TIMING.awayMs) later(() => void breakpoint(), NUDGE_TIMING.returnPauseMs);
    };
    // Reviewer / QA: window.dispatchEvent(new CustomEvent("papr-nudge-preview", { detail })) plays a nudge
    // without touching the ledger or the policy.
    // A preview replaces whatever is up, so the Dev tab can step through several in a row.
    const onPreview = (e: Event) => {
      const n = (e as CustomEvent<AgentNudgeData | undefined>).detail ?? PREVIEW_NUDGE;
      window.clearTimeout(parkTimer.current);
      play({ ...n, key: n.key.startsWith("preview:") ? n.key : `preview:${n.key}` });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onAway);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onAway);
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("papr-nudge-preview", onPreview);
    const pending = timers.current;
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(parkTimer.current);
      pending.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onAway);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("papr-nudge-preview", onPreview);
    };
  }, [breakpoint, play]);

  // Breakpoint 3: a piece of work just landed.
  useEffect(() => {
    const was = workRef.current;
    workRef.current = workState;
    if (was === "working" && workState !== "working") later(() => void breakpoint(), NUDGE_TIMING.afterWorkMs);
  }, [workState, breakpoint]);

  const leave = (event: "later" | "dismiss") => {
    const n = nudgeRef.current;
    if (!n) return;
    window.clearTimeout(parkTimer.current);
    if (!n.key.startsWith("preview:")) send(n, event);
    setPhase("out");
    restDay.current = today();
    later(() => setPhase(event === "later" ? "rest" : "off"), NUDGE_TIMING.leaveMs);
  };

  return {
    nudge,
    phase,
    go: () => {
      const n = nudgeRef.current;
      if (!n) return;
      window.clearTimeout(parkTimer.current);
      if (!n.key.startsWith("preview:")) send(n, "go");
      setPhase("off");
      onGo(n.action);
    },
    later: () => leave("later"),
    dismiss: () => leave("dismiss"),
    /** Tap the resting dot: the same nudge opens again (not a new show). */
    reopen: () => nudgeRef.current && play(nudgeRef.current),
    /** Hovering the whisper holds it open. */
    hold: (on: boolean) => (on ? window.clearTimeout(parkTimer.current) : armPark()),
  };
}

export const PREVIEW_NUDGE: AgentNudgeData = {
  key: "drift-sample",
  kind: "drift",
  line: "Embed training got 14h this week. The raise got 2h.",
  sub: "Tranche 2 is your #1 focus",
  go: "Plan time for it",
  later: "Later",
  dismiss: "It's intentional",
  action: { type: "focus" },
};
