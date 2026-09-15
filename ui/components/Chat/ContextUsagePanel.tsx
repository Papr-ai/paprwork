/**
 * Context & cost, one surface.
 *
 * Order is deliberate: how full the window is, what fills it, what the last
 * turn cost. Everything below the fold is opt-in — the panel answers the
 * question at a glance and only unfolds when asked.
 */

import React, { useState } from "react";
import type { ContextInfo } from "./contextInfo";
import { ContextSegmentDetail } from "./ContextSegmentDetail";
import { ContextStackBar } from "./ContextStackBar";
import { TurnCostStrip } from "./TurnCostStrip";
import {
  deriveSegments,
  fillFraction,
  formatCost,
  formatDuration,
  formatTokens,
  meterVisualStatus,
  rawFillFraction,
  type ContextMeter,
  type LiveTurn,
} from "./contextMeterModel";
import {
  chatModelIsFable,
  formatChatTotalsLine,
  type BillingMode,
  type PlanProvider,
  type PlanUsageSummary,
} from "../../utils/subscriptionPlanUsage";
import { ContextMeteredCostHero } from "./ContextMeteredCostHero";
import { ContextPlanUsageHero } from "./ContextPlanUsageHero";
import "./ContextMeter.css";

interface ContextUsagePanelProps {
  meter: ContextMeter;
  /** Non-null while a turn is running, with a client-ticked elapsed clock. */
  live: LiveTurn | null;
  info: ContextInfo | null;
  infoLoading: boolean;
  infoError: string | null;
  billingMode: BillingMode;
  planUsage: PlanUsageSummary | null;
  /** Whose allowance `planUsage` describes, or null on an API key. */
  planProvider: PlanProvider | null;
  chatModelId: string;
  onRetryBreakdown: () => void;
  onClose: () => void;
  /** A segment id opens the inspector already on that section. */
  onOpenFullInspector: (sectionId?: string) => void;
}

function contextFillTooltipLines(
  meter: ContextMeter,
  info: ContextInfo | null,
  shownPercent: number,
): string[] {
  const lines: string[] = [];
  const windowLabel = formatTokens(meter.effectiveWindow);
  const usedLabel = formatTokens(meter.usedTokens);
  if (meter.fillSource === "billed") {
    lines.push(`${usedLabel} of ${windowLabel} · estimated peak`);
  } else {
    lines.push(`${usedLabel} of ${windowLabel} · largest request`);
  }

  if (shownPercent > 100 && meter.userCap) {
    lines.push(
      `${formatTokens(meter.userCap)} cap applies to history only. Tools and system prompt are extra, so this can exceed 100%.`,
    );
  } else if (info && info.totalTokens > 0) {
    lines.push(`Next send ~${formatTokens(info.totalTokens)} total.`);
  }

  return lines;
}

export const ContextUsagePanel: React.FC<ContextUsagePanelProps> = ({
  meter,
  live,
  info,
  infoLoading,
  infoError,
  billingMode,
  planUsage,
  planProvider,
  chatModelId,
  onRetryBreakdown,
  onClose,
  onOpenFullInspector,
}) => {
  const [openSegment, setOpenSegment] = useState<string | null>(null);

  const fraction = fillFraction(meter);
  const status = meterVisualStatus(fraction);
  const shownPercent = Math.round(rawFillFraction(meter) * 100);
  const segments = info ? deriveSegments(info) : [];
  const fillTooltipLines = contextFillTooltipLines(
    meter,
    info,
    shownPercent,
  );
  // A model-scoped weekly limit only bills the model it scopes to, so it
  // decides the cost basis only while that model is selected.
  const costBasisOptions = {
    scopedWeeklyApplies: chatModelIsFable(chatModelId),
  };

  return (
    <div className="ctx-panel" role="dialog" aria-label="Context usage">
      <div className="ctx-panel__chrome">
        <header className="ctx-panel__head">
          <span className="ctx-panel__title">Context</span>
          {live ? <span className="ctx-panel__live">Live</span> : null}
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
        <div className="ctx-panel__hero-left">
          <div className="ctx-panel__pct-row">
            <div className={`ctx-panel__pct ctx-panel__pct--${status}`}>
              {shownPercent}%
            </div>
            <span className="ctx-panel__info-wrap">
              <button
                type="button"
                className="ctx-panel__info"
                aria-label="How this percentage is calculated"
              >
                i
              </button>
              <span className="ctx-panel__info-tip" role="tooltip">
                {fillTooltipLines.map((line) => (
                  <span key={line} className="ctx-panel__info-tip-line">
                    {line}
                  </span>
                ))}
              </span>
            </span>
          </div>
        </div>
        <div className="ctx-panel__hero-right">
          {billingMode === "subscription" ? (
            <ContextPlanUsageHero
              liveElapsedMs={live ? live.elapsedMs : null}
              planProvider={planProvider}
              chatModelId={chatModelId}
              planUsage={planUsage}
              lastTurnCost={meter.lastTurn?.cost ?? null}
            />
          ) : (
            <ContextMeteredCostHero
              liveElapsedMs={live ? live.elapsedMs : null}
              lastTurnCost={meter.lastTurn?.cost ?? 0}
              formatMeteredCost={formatCost}
            />
          )}
        </div>
        </div>
      </div>

      <div className="ctx-panel__body">
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
                  <ContextSegmentDetail
                    segment={segment}
                    info={info}
                    onOpenFull={onOpenFullInspector}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <TurnCostStrip
        meter={meter}
        live={live}
        billingMode={billingMode}
        planUsage={planUsage}
        costBasisOptions={costBasisOptions}
      />

      <footer className="ctx-panel__foot">
        <span>
          {formatChatTotalsLine(
            billingMode,
            meter.totals.turns,
            meter.totals.cost,
            planUsage,
            costBasisOptions,
          )}
        </span>
        {/* Disabled rather than a no-op: the breakdown it opens is the thing
            that failed to load, so an enabled button would lie about that. */}
        <button
          type="button"
          className="ctx-panel__link"
          onClick={() => onOpenFullInspector()}
          disabled={!info}
          title={info ? undefined : "The context breakdown could not be read."}
        >
          Full inspector ›
        </button>
      </footer>
      </div>
    </div>
  );
};
