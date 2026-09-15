/**
 * What the last turn actually cost, in the terms that explain the bill.
 *
 * The unit of spend is a **step** — every step re-sends the whole context —
 * so steps lead and tokens follow. Compaction, recovery fetches and peak
 * context live one disclosure down: they explain a surprising number, and
 * nobody needs them when the number is unsurprising.
 */

import React, { useState } from "react";
import {
  formatCachedInputShare,
  formatDuration,
  formatTokens,
  formatTurnPeakFillPercent,
  turnPeakFillPercent,
  resolveStepContextTokensForTurn,
  type ContextMeter,
  type LiveTurn,
} from "./contextMeterModel";
import {
  costBasisRunningNote,
  costBasisStatLabel,
  costBasisIsCharged,
  formatCostAmount,
  resolveCostBasis,
  type BillingMode,
  type PlanUsageSummary,
} from "../../utils/subscriptionPlanUsage";

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="ctx-stat">
    <span className="ctx-stat__value">{value}</span>
    <span className="ctx-stat__label">{label}</span>
  </div>
);

export const TurnCostStrip: React.FC<{
  meter: ContextMeter;
  live: LiveTurn | null;
  billingMode: BillingMode;
  planUsage: PlanUsageSummary | null;
}> = ({ meter, live, billingMode, planUsage }) => {
  const [open, setOpen] = useState(false);
  const turn = meter.lastTurn;
  const basis = resolveCostBasis(billingMode, planUsage);

  /**
   * A running turn takes over the strip. The alternative — showing the
   * previous turn's figures under the heading "This turn" — is what made the
   * panel look broken: four em-dashes and a stale price, while the agent was
   * visibly doing work.
   */
  if (live) {
    const livePct = live.peakContextTokens
      ? turnPeakFillPercent(
          {
            peakContextTokens: live.peakContextTokens,
            promptTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          meter.effectiveWindow,
        )
      : null;
    return (
      <div className="ctx-turn ctx-turn--live">
        <div className="ctx-turn__head">
          <span className="ctx-turn__title">This turn</span>
          <span className="ctx-turn__running">running</span>
        </div>
        <div className="ctx-turn__stats">
          <Stat label="steps" value={String(live.steps)} />
          <Stat label="tools" value={String(live.toolCalls)} />
          <Stat label="time" value={formatDuration(live.elapsedMs)} />
          <Stat
            label="context"
            value={formatTurnPeakFillPercent(livePct)}
          />
        </div>
        {/* Cost is the one figure with no honest live value: providers report
            it when the turn closes. Naming the omission beats a placeholder
            number that silently changes. */}
        <p className="ctx-turn__note">{costBasisRunningNote(basis)}</p>
      </div>
    );
  }

  if (!turn) {
    return (
      <div className="ctx-turn ctx-turn--empty">
        No turn measured in this chat yet.
      </div>
    );
  }

  const steps = turn.steps ?? null;
  const totalInputTokens = resolveStepContextTokensForTurn({
    inputTokens: turn.promptTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens,
  });
  const perStep =
    steps && steps > 0 && totalInputTokens > 0
      ? totalInputTokens / steps
      : null;

  const peakFillPct = turnPeakFillPercent(turn, meter.effectiveWindow);

  // How far the chars/4 estimator — the same one gating compaction and the
  // history trim — was from the provider's own figure on this turn.
  const drift =
    turn.peakContextTokens && turn.estimatedContextTokens
      ? turn.peakContextTokens / turn.estimatedContextTokens
      : null;

  return (
    <div className="ctx-turn">
      <div className="ctx-turn__head">
        <span className="ctx-turn__title">This turn</span>
        <button
          type="button"
          className={`ctx-turn__toggle${open ? " is-open" : ""}`}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? "Less" : "Detail"}
        </button>
      </div>

      <div className="ctx-turn__stats">
        <Stat label="steps" value={steps === null ? "—" : String(steps)} />
        <Stat
          label="tools"
          value={turn.toolCalls === null ? "—" : String(turn.toolCalls)}
        />
        <Stat label="time" value={formatDuration(turn.durationMs)} />
        <Stat
          label="context"
          value={formatTurnPeakFillPercent(peakFillPct)}
        />
        {/* Always shown. A subscription past its included allowance is
            spending real money per turn, so hiding the figure there removed
            it from exactly the users who needed to see it. */}
        <Stat
          label={costBasisStatLabel(basis)}
          value={
            turn.cost === null
              ? "—"
              : costBasisIsCharged(basis)
                ? formatCostAmount(turn.cost)
                : `≈${formatCostAmount(turn.cost)}`
          }
        />
      </div>

      {open ? (
        <dl className="ctx-turn__detail">
          <div>
            <dt>Peak context</dt>
            <dd>
              {turn.peakContextTokens
                ? `${formatTokens(turn.peakContextTokens)} of ${formatTokens(meter.effectiveWindow)} window`
                : "—"}
            </dd>
          </div>
          <div>
            {/* Billed across every step — not the size of any one request. */}
            <dt>Billed prompt / output</dt>
            <dd>
              {formatTokens(turn.promptTokens)} /{" "}
              {formatTokens(turn.completionTokens)}
            </dd>
          </div>
          <div>
            <dt>Billed per step</dt>
            <dd>{perStep ? formatTokens(Math.round(perStep)) : "—"}</dd>
          </div>
          <div>
            <dt>Cached prompt</dt>
            <dd>{formatCachedInputShare(turn)}</dd>
          </div>
          {drift ? (
            <div>
              <dt>Estimator drift</dt>
              <dd>{drift.toFixed(2)}× under</dd>
            </div>
          ) : null}
          <div>
            <dt>Compaction</dt>
            <dd>
              {turn.compactionRuns ?? 0} ran · {turn.compactionSkips ?? 0}{" "}
              declined
            </dd>
          </div>
          <div>
            <dt>Recovery fetches</dt>
            <dd>
              {turn.recoveryFetches ?? 0}
              {turn.redundantRecoveries
                ? ` · ${turn.redundantRecoveries} redundant`
                : ""}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
};
