/**
 * Context & cost, one surface.
 *
 * Order is deliberate: how full the window is, what fills it, what the last
 * turn cost. Everything below the fold is opt-in — the panel answers the
 * question at a glance and only unfolds when asked.
 */

import React, { useState } from "react";
import type { ContextInfo } from "./ContextInspectorModal";
import { ContextSegmentDetail } from "./ContextSegmentDetail";
import { ContextStackBar } from "./ContextStackBar";
import { TurnCostStrip } from "./TurnCostStrip";
import {
  deriveSegments,
  fillFraction,
  formatCost,
  formatTokens,
  meterStatus,
  rawFillFraction,
  type ContextMeter,
} from "./contextMeterModel";
import "./ContextMeter.css";

interface ContextUsagePanelProps {
  meter: ContextMeter;
  info: ContextInfo | null;
  infoLoading: boolean;
  infoError: string | null;
  onRetryBreakdown: () => void;
  onClose: () => void;
  onOpenFullInspector: () => void;
}

export const ContextUsagePanel: React.FC<ContextUsagePanelProps> = ({
  meter,
  info,
  infoLoading,
  infoError,
  onRetryBreakdown,
  onClose,
  onOpenFullInspector,
}) => {
  const [openSegment, setOpenSegment] = useState<string | null>(null);

  const fraction = fillFraction(meter);
  const status = meterStatus(fraction);
  const shownPercent = Math.round(rawFillFraction(meter) * 100);
  const segments = info ? deriveSegments(info) : [];

  return (
    <div className="ctx-panel" role="dialog" aria-label="Context usage">
      <header className="ctx-panel__head">
        <span className="ctx-panel__title">Context</span>
        <span className="ctx-panel__model">{meter.model}</span>
        <button
          type="button"
          className="ctx-panel__close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <div className="ctx-panel__hero">
        <div>
          <div className={`ctx-panel__pct ctx-panel__pct--${status}`}>
            {shownPercent}%
          </div>
          <div className="ctx-panel__sub">
            {formatTokens(meter.usedTokens)} of{" "}
            {formatTokens(meter.effectiveWindow)} tokens
            {/* Say so when the last turn predates the peak measurement. */}
            {meter.fillSource === "billed" ? " · estimated" : ""}
          </div>
        </div>
        <div className="ctx-panel__hero-right">
          <div className="ctx-panel__cost">
            {formatCost(meter.lastTurn?.cost ?? 0)}
          </div>
          <div className="ctx-panel__sub">last turn</div>
        </div>
      </div>

      <ContextStackBar
        segments={segments}
        usedTokens={meter.usedTokens}
        window={meter.effectiveWindow}
        status={status}
        highlightId={openSegment}
      />

      {infoLoading && segments.length === 0 ? (
        <div className="ctx-panel__pending">Reading the next prompt…</div>
      ) : null}

      {!infoLoading && infoError ? (
        <div className="ctx-panel__failed">
          <span>{infoError}</span>
          <button
            type="button"
            className="ctx-panel__link"
            onClick={onRetryBreakdown}
          >
            Try again
          </button>
        </div>
      ) : null}

      <ul className="ctx-legend">
        {segments.map((segment) => {
          const isOpen = openSegment === segment.id;
          return (
            <li key={segment.id} className="ctx-legend__item">
              <button
                type="button"
                className="ctx-legend__row"
                onClick={() => setOpenSegment(isOpen ? null : segment.id)}
                aria-expanded={isOpen}
              >
                <span
                  className={`ctx-legend__dot ctx-legend__dot--${segment.tone}`}
                />
                <span className="ctx-legend__label">{segment.label}</span>
                {segment.note ? (
                  <span className="ctx-legend__note">{segment.note}</span>
                ) : null}
                <span className="ctx-legend__tokens">
                  {formatTokens(segment.tokens)}
                </span>
                <span className={`ctx-legend__chev${isOpen ? " is-open" : ""}`}>
                  ›
                </span>
              </button>
              {isOpen && info ? (
                <div className="ctx-detail">
                  <ContextSegmentDetail segmentId={segment.id} info={info} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <TurnCostStrip meter={meter} />

      <footer className="ctx-panel__foot">
        <span>
          {meter.totals.turns} turns · {formatCost(meter.totals.cost)} this chat
        </span>
        {/* Disabled rather than a no-op: the breakdown it opens is the thing
            that failed to load, so an enabled button would lie about that. */}
        <button
          type="button"
          className="ctx-panel__link"
          onClick={onOpenFullInspector}
          disabled={!info}
          title={info ? undefined : "The context breakdown could not be read."}
        >
          Full inspector ›
        </button>
      </footer>
    </div>
  );
};
