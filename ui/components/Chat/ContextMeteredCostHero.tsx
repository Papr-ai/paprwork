import React from "react";
import { formatDuration } from "./contextMeterModel";

/** API-key / metered billing — last turn dollar estimate. */
export const ContextMeteredCostHero: React.FC<{
  liveElapsedMs: number | null;
  lastTurnCost: number;
  formatMeteredCost: (cost: number) => string;
}> = ({ liveElapsedMs, lastTurnCost, formatMeteredCost }) => {
  if (liveElapsedMs !== null) {
    return (
      <>
        <div className="ctx-panel__cost">{formatDuration(liveElapsedMs)}</div>
        <div className="ctx-panel__sub">running</div>
      </>
    );
  }
  return (
    <>
      <div className="ctx-panel__cost">{formatMeteredCost(lastTurnCost)}</div>
      <div className="ctx-panel__sub">last turn (API est.)</div>
    </>
  );
};
