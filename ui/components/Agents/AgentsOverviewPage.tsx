import { useEffect, useMemo, useRef, useState } from "react";
import { useSubAgents } from "../../hooks/useSubAgents";
import { useTabs } from "../../hooks/useTabs";
import { useSubAgentsStore } from "../../stores/subAgentsStore";
import { OverviewBody } from "./overview/OverviewBody";
import { useAgentsOverview } from "./overview/useAgentsOverview";
import "./AgentsOverviewPage.css";

const RANGES = [7, 30, 90] as const;

/**
 * Agents page: what your agents did and what it cost, in the Home brief
 * language — left-aligned hero, quiet rows, details on click.
 */
export function AgentsView() {
  const [days, setDays] = useState<number>(30);
  const { agents, runs } = useSubAgents();
  const { activeLeftTab, activeRightTab, getTab } = useTabs();
  const visible = useMemo(() => {
    const l = activeLeftTab ? getTab(activeLeftTab) : null;
    const r = activeRightTab ? getTab(activeRightTab) : null;
    return l?.type === "agents" || r?.type === "agents";
  }, [activeLeftTab, activeRightTab, getTab]);
  const { data, loading, error } = useAgentsOverview(days, visible);

  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) void useSubAgentsStore.getState().ensureLoaded();
    wasVisible.current = visible;
  }, [visible]);

  const range = (
    <div className="ag-range" role="tablist" aria-label="Time range">
      {RANGES.map((d) => (
        <button key={d} type="button" className={d === days ? "is-on" : ""} onClick={() => setDays(d)}>
          {d} days
        </button>
      ))}
    </div>
  );

  if (!data) {
    return (
      <div className="ag-page">
        <div className="ag-brief">
          {error ? <div className="ag-empty"><p>{error}</p></div> : <div className="ag-loading">{loading ? "Loading agent usage…" : ""}</div>}
        </div>
      </div>
    );
  }

  if (data.totals.turns === 0) {
    return (
      <div className="ag-page">
        <div className="ag-brief ag-empty">
          <div className="ag-hero-date">Agents</div>
          <h1 className="ag-hero-title">No agent turns yet</h1>
          <p>Start a chat. Every turn's cost and context shows up here, the same numbers as the meter in the chat box.</p>
          {range}
        </div>
      </div>
    );
  }

  return (
    <div className="ag-page">
      <OverviewBody data={data} agents={agents} runs={runs} range={range} />
    </div>
  );
}
