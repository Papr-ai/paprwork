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

  useEffect(() => {
    if (wasSending.current && !isSending) void loadMeter();
    wasSending.current = isSending;
  }, [isSending, loadMeter]);

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

  return (
    <div className="ctx-meter" ref={containerRef}>
      {open ? (
        <ContextUsagePanel
          meter={meter}
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
          showLabel={status !== "calm"}
        />
      </button>
    </div>
  );
};
