import { useState } from "react";
import type { AgentsOverview } from "../../../../src/core/types/agentsOverview";
import { formatClaudeUsageReset } from "../../../utils/claudeUsageFormat";
import { monthTotal, readPlanPriceOverride, writePlanPriceOverride } from "../../../utils/planPricing";
import { planAtIncludedLimit, planUsageBrand } from "../../../utils/subscriptionPlanUsage";
import type { PlanReading } from "./usePlanUsage";
import { usd } from "./format";

function Bar({ label, percent, reset }: { label: string; percent: number; reset?: string | null }) {
  const tone = percent >= 100 ? "is-bad" : percent >= 80 ? "is-warn" : "";
  return (
    <div className="ag-plan-bar">
      <div className="ag-plan-bar-h">
        <span>{label}</span>
        <b>{percent}%</b>
      </div>
      <div className="ag-meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} ${percent}% used`}>
        <i className={tone} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      {reset ? <small>{formatClaudeUsageReset(reset)}</small> : null}
    </div>
  );
}

/** One plain sentence: is this plan costing anything beyond its price right now? */
function planStatus(p: PlanReading): { text: string; tone: "ok" | "warn" | "bad" } {
  if (!planAtIncludedLimit(p.summary)) return { text: "Inside plan limits — no extra charge", tone: "ok" };
  if (p.summary.extraUsageEnabled === false) return { text: "At a limit — extra usage is off, so requests wait for the reset", tone: "warn" };
  if (p.extraSpentUsd !== null) return { text: `At a limit — extra usage billed this month: ${usd(p.extraSpentUsd)}`, tone: "bad" };
  return { text: "At a limit — extra usage may be billed on top", tone: "bad" };
}

function PriceEditor({ p, price, onChange }: { p: PlanReading; price: number | null; onChange: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(price === null ? "" : String(price));
  if (!editing) {
    return (
      <button type="button" className="ag-plan-price" title="Set what you pay for this plan" onClick={() => setEditing(true)}>
        {price === null ? "Set price" : `${usd(price)}/mo`}
      </button>
    );
  }
  const commit = () => {
    const n = draft.trim() === "" ? null : Number(draft);
    const value = n === null || !Number.isFinite(n) || n < 0 ? null : n;
    writePlanPriceOverride(p.provider, value);
    onChange(value);
    setEditing(false);
  };
  return (
    <span className="ag-plan-edit">
      $<input autoFocus inputMode="decimal" aria-label="Monthly price in USD" value={draft}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />/mo
    </span>
  );
}

function PlanRow({ p, price, setPrice }: { p: PlanReading; price: number | null; setPrice: (v: number | null) => void }) {
  const s = p.summary;
  const status = planStatus(p);
  return (
    <div className="ag-plan">
      <div className="ag-plan-h">
        <div className="ag-min">
          <div className="ag-row-title">{planUsageBrand(p.provider)}{p.plan ? ` · ${p.plan.label}` : ""}</div>
          <div className={`ag-plan-status is-${status.tone}`}>{status.text}</div>
        </div>
        <PriceEditor p={p} price={price} onChange={setPrice} />
      </div>
      <div className="ag-plan-bars">
        {s.sessionPercent !== null && <Bar label="Session" percent={s.sessionPercent} reset={p.resets.session} />}
        {s.weeklyPercent !== null && <Bar label="Weekly" percent={s.weeklyPercent} reset={p.resets.weekly} />}
        {s.scopedWeekly.map((w) => <Bar key={w.label} label={w.label} percent={w.percent} />)}
      </div>
    </div>
  );
}

export function PlanSection({ data, plans }: { data: AgentsOverview; plans: PlanReading[] | null }) {
  const list = plans ?? [];
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const priceOf = (p: PlanReading) =>
    p.provider in prices ? prices[p.provider] : readPlanPriceOverride(p.provider) ?? p.plan?.monthlyUsd ?? null;
  // Older gateways (and payloads cached before plan usage shipped) have no `month`.
  const m = data.month ?? { apiKey: 0, subscription: 0, papr: 0, unknown: 0, start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() };
  const providerExtra = list.reduce((a, p) => a + (p.extraSpentUsd ?? 0), 0);
  const sum = monthTotal({ planUsd: list.map(priceOf), apiKeyUsd: m.apiKey, paprUsd: m.papr, providerExtraUsd: providerExtra });
  const monthName = new Date(m.start).toLocaleDateString(undefined, { month: "long" });

  return (
    <div className="ag-pad">
      {list.map((p) => (
        <PlanRow key={p.provider} p={p} price={priceOf(p)} setPrice={(v) => setPrices((x) => ({ ...x, [p.provider]: v }))} />
      ))}
      {plans !== null && list.length === 0 && (
        <p className="ag-sub-sum">No Claude or ChatGPT subscription connected — turns are billed per token.</p>
      )}
      <div className="ag-plan-total">
        <div><small>Plans</small><b>{usd(sum.plans)}{sum.plansKnown ? "" : "+"}</b></div>
        <div><small>Billed on top</small><b>{usd(sum.extra)}</b></div>
        <div className="is-total"><small>{monthName} so far</small><b>{usd(sum.total)}{sum.plansKnown ? "" : "+"}</b></div>
      </div>
      <p className="ag-sub-sum">
        On top of plans: API keys {usd(m.apiKey)} · Papr credits {usd(m.papr)}
        {list.some((p) => p.provider === "anthropic") ? ` · Claude extra usage ${usd(providerExtra)}` : ""}.
        {" "}Subscription turns this month would have cost {usd(m.subscription)} at API prices — covered by the plan, not charged.
      </p>
    </div>
  );
}
