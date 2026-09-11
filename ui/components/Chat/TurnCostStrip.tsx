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
  formatCost,
  formatDuration,
  formatTokens,
  type ContextMeter,
} from "./contextMeterModel";

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="ctx-stat">
    <span className="ctx-stat__value">{value}</span>
    <span className="ctx-stat__label">{label}</span>
  </div>
);

export const TurnCostStrip: React.FC<{ meter: ContextMeter }> = ({ meter }) => {
  const [open, setOpen] = useState(false);
  const turn = meter.lastTurn;

  if (!turn) {
    return (
      <div className="ctx-turn ctx-turn--empty">
        No turn measured in this chat yet.
      </div>
    );
  }

  const steps = turn.steps ?? null;
  const cachedShare = turn.promptTokens
    ? turn.cacheReadTokens / turn.promptTokens
    : 0;
  const perStep = steps && steps > 0 ? turn.promptTokens / steps : null;

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
        <Stat label="cost" value={formatCost(turn.cost)} />
      </div>

      {open ? (
        <dl className="ctx-turn__detail">
          <div>
            <dt>Context per step</dt>
            <dd>{perStep ? formatTokens(Math.round(perStep)) : "—"}</dd>
          </div>
          <div>
            <dt>Prompt / output</dt>
            <dd>
              {formatTokens(turn.promptTokens)} /{" "}
              {formatTokens(turn.completionTokens)}
            </dd>
          </div>
          <div>
            <dt>Cached prompt</dt>
            <dd>{Math.round(cachedShare * 100)}%</dd>
          </div>
          <div>
            <dt>Peak context</dt>
            <dd>
              {turn.peakContextTokens
                ? formatTokens(turn.peakContextTokens)
                : "—"}
            </dd>
          </div>
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
