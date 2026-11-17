import React from "react";
import type { AgentsOverview } from "../../../../src/core/types/agentsOverview";
import type { DelegationRun, SubAgentProfile } from "../../../hooks/useSubAgents";
import { ChatRows, ModelRows } from "./ChatRows";
import { Hero } from "./Hero";
import { PlanSection } from "./PlanSection";
import type { PlanReading } from "./usePlanUsage";
import { Projects, ScheduledJobs, Team, Tools, WorkByType } from "./Sections";
import { pct, tok, usd } from "./format";

function Sec({ title, sub, children }: { title: string; sub: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="ag-sec">
      <div className="ag-sec-h">{title} <span>{sub}</span></div>
      {children}
    </section>
  );
}

/** Everything below the page chrome; no data loading, so it renders anywhere. */
export function OverviewBody({
  data,
  agents,
  runs,
  range,
  plans = null,
}: {
  data: AgentsOverview;
  agents: SubAgentProfile[];
  runs: DelegationRun[];
  range: React.ReactNode;
  plans?: PlanReading[] | null;
}) {
  const t = data.totals;
  const shownCost = data.chats.reduce((a, c) => a + c.cost, 0);
  return (
    <div className="ag-brief">
        <Hero data={data} />
        <Sec title="What you pay" sub="this month · plan price + anything billed on top"><PlanSection data={data} plans={plans} /></Sec>
        {range}
        <Sec title="Your team" sub="who did the work"><Team data={data} agents={agents} runs={runs} /></Sec>
        {(data.workTypes.length > 0 || data.unclassified.chats > 0) && (
          <Sec title="Work by type" sub="Jev-classified per chat"><WorkByType data={data} /></Sec>
        )}
        <Sec title="Where it went" sub={<>total tokens · cost — top {data.chats.length} chats = {pct(shownCost, t.cost)}% of spend</>}>
          <ChatRows data={data} />
        </Sec>
        <Sec title="Projects" sub="mini-apps and code repos"><Projects data={data} /></Sec>
        <Sec title="Scheduled jobs" sub="failing first"><ScheduledJobs /></Sec>
        <Sec title="Models" sub="cost"><ModelRows data={data} /></Sec>
        <Sec title="Tools" sub={`calls, last ${data.days} days`}><Tools data={data} /></Sec>
        <p className="ag-foot">
          <b>Same numbers as the context meter in each chat.</b> Summed from per-turn usage on every assistant message:
          new input + cache read + cache write + output. Peak context = largest single request in a turn.
          {t.avgSteps && t.avgPeak ? ` Average turn: ${t.avgSteps} steps, ${tok(t.avgPeak)} peak context.` : ""}
          {" "}Cost is the API-price value of each turn ({usd(t.cost)} total) — what it would cost on API keys.
          Turns on a subscription are covered by the plan; what you actually pay is under "What you pay".
        </p>
    </div>
  );
}
