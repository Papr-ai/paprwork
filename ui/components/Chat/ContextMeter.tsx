/**
 * The dial in the composer, and the panel behind it.
 *
 * Two reads, deliberately split by cost: the meter is one SQL row and refreshes
 * after every turn; the composition breakdown rebuilds the whole system prompt
 * and is only fetched when the panel opens.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { resolveAgentFocusContext } from "../../utils/agentFocusContext";
import { ContextMeterRing } from "./ContextMeterRing";
import { ContextUsagePanel } from "./ContextUsagePanel";
import { isContextInfo, type ContextInfo } from "./ContextInspectorModal";
import {
  fillFraction,
  isContextMeter,
  meterStatus,
  type ContextMeter as ContextMeterData,
} from "./contextMeterModel";
import "./ContextMeter.css";

/**
 * Cheap enough to run every second: one indexed SQLite row plus an in-memory
 * map read, over a local socket. The ceiling on freshness is the agent's step
 * boundary, not this.
 */
const LIVE_POLL_MS = 1000;

interface ContextMeterProps {
  chatId: string;
  model: string;
  /** Refresh once the agent stops streaming — that is when a turn is billed. */
  isSending: boolean;
  openSignal?: number;
  onOpenFullInspector: (info: ContextInfo) => void;
}

export const ContextMeter: React.FC<ContextMeterProps> = ({
  chatId,
  model,
  isSending,
  openSignal,
  onOpenFullInspector,
}) => {
  const [meter, setMeter] = useState<ContextMeterData | null>(null);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const wasSending = useRef(isSending);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadMeter = useCallback(async () => {
    try {
      const response = await gateway.send("chat:context-meter", {
        chatId,
        model,
      });
      if (isContextMeter(response.data)) setMeter(response.data);
    } catch {
      /* the dial is ambient: a failed read shows nothing, never an error */
    }
  }, [chatId, model]);

  useEffect(() => {
    void loadMeter();
  }, [loadMeter]);

  /**
   * While the agent works, re-read on a timer.
   *
   * The turn is the thing the user is watching and it is the one thing the
   * old meter could not see: everything about a turn is written to SQLite
   * once, at the end, so a refresh keyed only to the end of streaming left the
   * dial frozen for the entire time it had something to say. A step boundary
   * is seconds apart at best, so a 1s poll is never the limiting factor —
   * `getContextMeter` is a single indexed row plus an in-memory read.
   */
  useEffect(() => {
    if (!isSending) return;
    void loadMeter();
    const timer = window.setInterval(() => void loadMeter(), LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isSending, loadMeter]);

  useEffect(() => {
    // One final read after the turn lands, to swap the live figures for the
    // billed ones — cost only exists once the provider closes the turn.
    if (wasSending.current && !isSending) void loadMeter();
    wasSending.current = isSending;
  }, [isSending, loadMeter]);

  /**
   * The elapsed clock ticks on its own rather than waiting for a poll: time is
   * the one number that advances with no server involvement, and a "time" stat
   * that jumps in one-second steps looks stalled next to a spinner.
   */
  useEffect(() => {
    if (!meter?.liveTurn) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [meter?.liveTurn]);

  /**
   * Unlike `loadMeter`, this answers an explicit click, so a failure has to be
   * reported. Silence here is indistinguishable from a no-op: the panel and
   * the Full inspector button both key off `info`, so swallowing the error
   * left a button that looked clickable and did nothing.
   */
  const loadBreakdown = useCallback(async () => {
    setInfoLoading(true);
    setInfoError(null);
    try {
      const focusContext = resolveAgentFocusContext(chatId);
      const response = await gateway.send("chat:inspect-context", {
        chatId,
        model,
        ...(focusContext ? { focusContext } : {}),
      });
      if (isContextInfo(response.data)) {
        setInfo(response.data);
      } else {
        // A reply that arrives in the wrong shape is a different failure from
        // never getting one, and only this branch can tell them apart.
        setInfo(null);
        setInfoError("Gateway returned an unexpected context shape.");
      }
    } catch (error) {
      setInfo(null);
      setInfoError(
        error instanceof Error ? error.message : "Could not read the context.",
      );
    } finally {
      setInfoLoading(false);
    }
  }, [chatId, model]);

  const openPanel = useCallback(() => {
    setOpen(true);
    void loadMeter();
    void loadBreakdown();
  }, [loadMeter, loadBreakdown]);

  useEffect(() => {
    if (openSignal) openPanel();
  }, [openSignal, openPanel]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!meter) return null;

  const fraction = fillFraction(meter);
  const status = meterStatus(fraction);
  // `tick` exists only to force this render; its value is never used. Elapsed
  // is recomputed from the start time rather than accumulated, so a missed
  // interval — a backgrounded window throttling timers — corrects itself
  // instead of drifting permanently behind.
  void tick;
  const live = meter.liveTurn
    ? {
        ...meter.liveTurn,
        elapsedMs: Math.max(
          meter.liveTurn.elapsedMs,
          Date.now() - new Date(meter.liveTurn.startedAt).getTime(),
        ),
      }
    : null;

  return (
    <div className="ctx-meter" ref={containerRef}>
      {open ? (
        <ContextUsagePanel
          meter={meter}
          live={live}
          info={info}
          infoLoading={infoLoading}
          infoError={infoError}
          onClose={() => setOpen(false)}
          onRetryBreakdown={() => void loadBreakdown()}
          onOpenFullInspector={() => {
            if (!info) return;
            onOpenFullInspector(info);
            setOpen(false);
          }}
        />
      ) : null}
      <button
        type="button"
        className={`ctx-meter__btn ctx-meter__btn--${status}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={`Context ${Math.round(fraction * 100)}% full`}
        title={`Context ${Math.round(fraction * 100)}% full · ${meter.model}`}
      >
        <ContextMeterRing
          fraction={fraction}
          status={status}
          live={Boolean(live)}
          // A running turn is the moment the number matters most, so the label
          // stops being conditional on the window being nearly full.
          showLabel={status !== "calm" || Boolean(live)}
        />
      </button>
    </div>
  );
};
