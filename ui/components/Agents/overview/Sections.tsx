import React, { useEffect } from "react";
import type { AgentsOverview, AgentsOverviewProject } from "../../../../src/core/types/agentsOverview";
import type { DelegationRun, SubAgentProfile } from "../../../hooks/useSubAgents";
import { openJobInJobsTab } from "../../../stores/jobNavigationStore";
import { subscribeJobsFullPolling, useJobsStore } from "../../../stores/jobsStore";
import { Legend, MixBar } from "./Hero";
import { pct, scheduleLabel, tok, usd } from "./format";

export const Tag = ({ children }: { children: React.ReactNode }) => <em className="ag-tag">{children}</em>;

export function Team({ data, agents, runs }: { data: AgentsOverview; agents: SubAgentProfile[]; runs: DelegationRun[] }) {
  const main = data.agents.find((a) => a.id === "main-agent") ?? data.agents[0];
  const since = Date.now() - data.days * 864e5;
  const recent = runs.filter((r) => Date.parse(r.createdAt) >= since);
  const byAgent = new Map<string, number>();
  for (const r of recent) byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + 1);
  const subs = agents
    .map((a) => ({ a, n: byAgent.get(a.id) ?? 0 }))
    .filter((s) => s.n > 0)
    .sort((x, y) => y.n - x.n)
    .slice(0, 5);
  const done = recent.filter((r) => r.status === "completed").length;
  const failed = recent.filter((r) => r.status === "failed").length;
  const waiting = recent.length - done - failed;
  return (
    <>
      {main && (
        <div className="ag-row ag-trow">
          <span className="ag-avatar ag-avatar--main">P</span>
          <span className="ag-min">
            <div className="ag-row-title">Pen</div>
            <div className="ag-row-meta">Main agent · every chat turn</div>
          </span>
          <span className="ag-row-peak">{main.turns.toLocaleString()} turns</span>
          <span className="ag-row-cost">{usd(main.cost)}</span>
        </div>
      )}
      {subs.map(({ a, n }) => (
        <div className="ag-row ag-trow" key={a.id}>
          <span className="ag-avatar">{a.name[0]}</span>
          <span className="ag-min">
            <div className="ag-row-title">{a.name}</div>
            <div className="ag-row-meta">Sub-agent · {a.description}</div>
          </span>
          <span className="ag-row-peak">{n} runs</span>
          <span className="ag-row-cost"><Tag>cost not tracked</Tag></span>
        </div>
      ))}
      {recent.length > 0 && (
        <p className="ag-sub-sum">
          Sub-agents: {recent.length} runs · {pct(done, recent.length)}% completed · {failed} failed · {waiting} waiting
        </p>
      )}
    </>
  );
}

export function WorkByType({ data }: { data: AgentsOverview }) {
  const max = data.workTypes[0]?.cost || 1;
  return (
    <>
      {data.workTypes.map((w) => (
        <div className="ag-row ag-mrow" key={w.label}>
          <span className="ag-min">
            <div className="ag-row-title">{w.label}</div>
            <div className="ag-row-meta">{w.chats} chat{w.chats === 1 ? "" : "s"} · {pct(w.cost, data.totals.cost)}% of spend</div>
          </span>
          <span className="ag-meter"><i style={{ width: `${(w.cost / max) * 100}%` }} /></span>
          <span className="ag-row-cost">{usd(w.cost)}</span>
        </div>
      ))}
      {data.unclassified.chats > 0 && (
        <div className="ag-row ag-mrow">
          <span className="ag-min">
            <div className="ag-row-title">Not classified yet</div>
            <div className="ag-row-meta">
              {data.unclassified.chats} chat{data.unclassified.chats === 1 ? "" : "s"} · Jev labels the biggest ones once, in the background
            </div>
          </span>
          <span />
          <span className="ag-row-cost">{usd(data.unclassified.cost)}</span>
        </div>
      )}
    </>
  );
}

const APP_PARTS: Array<[string, string]> = [["Build", "--ag-c-out"], ["Edit & test", "--ag-c-cache"], ["Data & jobs", "--ag-c-write"], ["Discussion", "--ag-c-fresh"]];
const REPO_PARTS: Array<[string, string]> = [["Edit", "--ag-c-cache"], ["Build & test", "--ag-c-out"], ["Explore", "--ag-c-write"], ["Discussion", "--ag-c-fresh"]];

function ProjectRows({ list, parts, mono }: { list: AgentsOverviewProject[]; parts: Array<[string, string]>; mono?: boolean }) {
  return (
    <>
      {list.map((p) => (
        <div className="ag-row ag-prow" key={p.id}>
          <span className="ag-min">
            <div className={`ag-row-title${mono ? " ag-mono" : ""}`}>{p.name}</div>
            <div className="ag-row-meta">{tok(p.tokens)} tokens · {p.turns} turns · {p.chats} chat{p.chats === 1 ? "" : "s"}</div>
          </span>
          <span className="ag-psplit"><MixBar parts={p.split.map((n, i) => [n, parts[i][1]])} /></span>
          <span className="ag-row-cost">{usd(p.cost)}</span>
        </div>
      ))}
    </>
  );
}

export function Projects({ data }: { data: AgentsOverview }) {
  const w = data.projects.where;
  return (
    <>
      <div className="ag-pad"><MixBar parts={[[w.app, "--ag-c-cache"], [w.both, "--ag-c-write"], [w.repo, "--ag-c-out"], [w.none, "--ag-line"]]} /></div>
      <div className="ag-pad">
        <Legend items={[["Mini-apps only", "--ag-c-cache", usd(w.app)], ["Mini-apps + repo", "--ag-c-write", usd(w.both)], ["Code repos only", "--ag-c-out", usd(w.repo)], ["Neither", "--ag-line", usd(w.none)]]} />
      </div>
      {data.projects.apps.length > 0 && (
        <>
          <div className="ag-sub-h">Papr mini-apps</div>
          <div className="ag-pad"><Legend items={APP_PARTS.map(([l, c]) => [l, c])} /></div>
          <ProjectRows list={data.projects.apps} parts={APP_PARTS} />
        </>
      )}
      {data.projects.repos.length > 0 && (
        <>
          <div className="ag-sub-h">Code repos</div>
          <div className="ag-pad"><Legend items={REPO_PARTS.map(([l, c]) => [l, c])} /></div>
          <ProjectRows list={data.projects.repos} parts={REPO_PARTS} mono />
        </>
      )}
      <p className="ag-sub-sum">
        {data.projects.recordedShare >= 0.95
          ? "Recorded per turn from the files each turn touched."
          : "Older turns are inferred from file paths in tool calls; new turns are recorded."}{" "}
        A turn that touches an app and a repo counts in both lists.
      </p>
    </>
  );
}

const STATUS: Record<string, [string, string, number]> = {
  failed: ["bad", "Failing", 0],
  waiting_permission: ["warn", "Needs approval", 1],
  running: ["ok", "Running", 2],
  pending: ["idle", "Waiting", 3],
  cancelled: ["idle", "Cancelled", 4],
  completed: ["ok", "Healthy", 5],
};

export function ScheduledJobs() {
  useEffect(() => subscribeJobsFullPolling(), []);
  const jobs = useJobsStore((s) => s.jobs);
  const list = jobs
    .filter((j) => j.schedule?.enabled)
    .sort((a, b) => (STATUS[a.status]?.[2] ?? 9) - (STATUS[b.status]?.[2] ?? 9));
  if (list.length === 0) return <p className="ag-sub-sum">No scheduled jobs. Jobs you schedule show up here.</p>;
  return (
    <div className="ag-cards">
      {list.map((j) => {
        const [dot, label] = STATUS[j.status] ?? ["idle", j.status];
        return (
          <button
            key={j.id}
            type="button"
            className={`ag-jcard${j.status === "failed" ? " ag-jcard--bad" : ""}`}
            onClick={() => openJobInJobsTab(j.id)}
            title="Open in Jobs"
          >
            <div className="ag-row-title">{j.name}</div>
            <div className="ag-row-meta">{j.type}</div>
            <div className="ag-jcard-freq">{scheduleLabel(j.schedule)}</div>
            <div className="ag-jcard-status"><i className={`ag-dot ag-dot--${dot}`} />{label}</div>
          </button>
        );
      })}
    </div>
  );
}

export function Tools({ data }: { data: AgentsOverview }) {
  const { total, top, bash } = data.tools;
  const bashTotal = top.find(([n]) => n === "bash")?.[1] ?? bash.reduce((a, [, n]) => a + n, 0);
  const sorted = [...bash].sort((a, b) => b[1] - a[1]);
  const tail = sorted.slice(3);
  const shown: Array<[string, number]> = [
    ...sorted.slice(0, 3),
    ...(tail.length ? ([[`Other bash${tail.some(([n]) => n !== "Other") ? ` · ${tail.filter(([n]) => n !== "Other").slice(0, 4).map(([n]) => n.toLowerCase()).join(", ")}` : ""}`, tail.reduce((a, [, n]) => a + n, 0)]] as Array<[string, number]>) : []),
  ];
  const bmax = shown[0]?.[1] || 1;
  const rest = top.filter(([n]) => n !== "bash");
  const max = rest[0]?.[1] || 1;
  return (
    <>
      {bashTotal > 0 && (
        <>
          <div className="ag-row ag-mrow">
            <span className="ag-min">
              <div className="ag-row-title ag-mono">bash</div>
              <div className="ag-row-meta">{pct(bashTotal, total)}% of calls{sorted[0] ? ` · ${pct(sorted[0][1], bashTotal)}% of it is ${sorted[0][0].toLowerCase()}` : ""}</div>
            </span>
            <span className="ag-meter"><i style={{ width: "100%" }} /></span>
            <span className="ag-row-cost">{bashTotal.toLocaleString()}</span>
          </div>
          <div className="ag-bash-split">
            {shown.map(([name, n]) => (
              <div className="ag-row ag-mrow ag-brow" key={name}>
                <span className="ag-min">
                  <div className="ag-row-title">{name}</div>
                  <div className="ag-row-meta">{pct(n, bashTotal)}% of bash · {pct(n, total)}% of all calls</div>
                </span>
                <span className="ag-meter"><i style={{ width: `${(n / bmax) * 100}%` }} /></span>
                <span className="ag-row-cost">{n.toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div className="ag-sub-h">Other tools</div>
        </>
      )}
      {rest.map(([name, n]) => (
        <div className="ag-row ag-mrow" key={name}>
          <span className="ag-min">
            <div className="ag-row-title ag-mono">{name}</div>
            <div className="ag-row-meta">{pct(n, total)}% of calls</div>
          </span>
          <span className="ag-meter"><i style={{ width: `${(n / max) * 100}%` }} /></span>
          <span className="ag-row-cost">{n.toLocaleString()}</span>
        </div>
      ))}
    </>
  );
}
