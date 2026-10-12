import React from "react";
import type { AgentsOverview } from "../../../../src/core/types/agentsOverview";
import { pct, tok, usd } from "./format";

export function MixBar({ parts }: { parts: Array<[number, string]> }) {
  const total = parts.reduce((a, [n]) => a + n, 0) || 1;
  return (
    <div className="ag-mix-bar">
      {parts.map(([n, color], i) => (
        <span key={i} style={{ width: `${(n / total) * 100}%`, background: `var(${color})` }} />
      ))}
    </div>
  );
}

export function Legend({ items }: { items: Array<[string, string, React.ReactNode?]> }) {
  return (
    <div className="ag-legend">
      {items.map(([label, color, value]) => (
        <span key={label}>
          <i style={{ background: `var(${color})` }} />
          {label} {value !== undefined && <b>{value}</b>}
        </span>
      ))}
    </div>
  );
}

function fillDays(daily: AgentsOverview["daily"], days: number): Array<[string, number]> {
  const byDate = new Map(daily.map((d) => [d.date, d.cost]));
  const out: Array<[string, number]> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    out.push([d, byDate.get(d) ?? 0]);
  }
  return out;
}

const short = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Trend({ data }: { data: AgentsOverview }) {
  const days = fillDays(data.daily, data.days);
  const max = Math.max(...days.map(([, v]) => v), 0.01);
  const peak = days.find(([, v]) => v === max);
  return (
    <>
      <div className="ag-trend" aria-label={`Daily cost, last ${data.days} days`}>
        {days.map(([d, v]) => (
          <i
            key={d}
            className={v === max ? "is-peak" : ""}
            style={{ height: `${v > 0 ? Math.max(4, (v / max) * 100) : 2}%` }}
            title={`${short(d)} · ${usd(v)}`}
          />
        ))}
      </div>
      <div className="ag-trend-axis">
        <span>{short(days[0][0])}</span>
        {peak && <span>Peak {usd(max)} · {short(peak[0])}</span>}
        <span>Today</span>
      </div>
    </>
  );
}

function Billing({ b }: { b: AgentsOverview["billing"] }) {
  const known = b.apiKey + b.subscription + b.papr;
  if (known === 0) {
    return (
      <div className="ag-bill">
        <Legend items={[["Billing source recorded from now on", "--ag-track"]]} />
      </div>
    );
  }
  return (
    <div className="ag-bill">
      <MixBar parts={[[b.apiKey, "--ag-blue"], [b.papr, "--ag-c-write"], [b.subscription, "--ag-track"], [b.unknown, "--ag-line"]]} />
      <Legend
        items={[
          ["Billed to API keys", "--ag-blue", usd(b.apiKey)],
          ...(b.papr > 0 ? ([["Papr credits", "--ag-c-write", usd(b.papr)]] as Array<[string, string, string]>) : []),
          ["Covered by subscription", "--ag-track", usd(b.subscription)],
          ...(b.unknown > 0 ? ([["Before tracking", "--ag-line", usd(b.unknown)]] as Array<[string, string, string]>) : []),
        ]}
      />
    </div>
  );
}

export function Hero({ data }: { data: AgentsOverview }) {
  const t = data.totals;
  return (
    <header className="ag-hero">
      <div className="ag-hero-date">Agents · last {data.days} days</div>
      <h1 className="ag-hero-title">
        Your agents did {t.turns.toLocaleString()} turns of work across {t.chats} chats
      </h1>
      <div className="ag-hero-stats">
        <span><b>{usd(t.today)}</b> today</span>
        <span><b>{usd(t.week)}</b> this week</span>
        <span><b>{usd(t.cost)}</b> {data.days} days</span>
        <span><b>{tok(t.tokens)}</b> tokens · {pct(t.cacheRead, t.tokens)}% from cache</span>
      </div>
      <Billing b={data.billing} />
      <Trend data={data} />
      <div className="ag-mix">
        <MixBar parts={[[t.cacheRead, "--ag-c-cache"], [t.cacheWrite, "--ag-c-write"], [t.fresh, "--ag-c-fresh"], [t.output, "--ag-c-out"]]} />
        <Legend
          items={[
            ["Cache read", "--ag-c-cache", tok(t.cacheRead)],
            ["Cache write", "--ag-c-write", tok(t.cacheWrite)],
            ["New input", "--ag-c-fresh", tok(t.fresh)],
            ["Output", "--ag-c-out", tok(t.output)],
          ]}
        />
      </div>
    </header>
  );
}
