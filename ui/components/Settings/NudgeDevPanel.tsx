/**
 * Settings → Dev → Nudges. Only DevTab imports this, so it is dropped from packaged builds with it.
 *
 * One question: "what would my agent say right now, and why?" Shows the policy's live verdict, every
 * candidate with the reason it would be skipped, and plays any of them on the rail agent. Previews
 * never touch the ledger or the caps. Reset wipes shown/mutes/backoff (the gateway refuses in prod).
 */
import { useCallback, useEffect, useState } from "react";
import { getGatewayHttpBase } from "../../utils/gatewayHttpBase";
import { PREVIEW_NUDGE, type AgentNudgeData } from "../Agent/useAgentNudge";

type Candidate = AgentNudgeData & { priority: number; source: string; blocked: string | null };

interface NudgeDebug {
  decision: { nudge: Candidate | null; reason: string; retryAt?: string };
  candidates: Candidate[];
  ledger: {
    today: number;
    week: number;
    unengaged: number;
    cooldownHours: number;
    nextAllowedAt: string | null;
    muted: Record<string, string>;
    recent: Array<{ key: string; kind: string; at: string; outcome?: string }>;
  };
  rules: { maxPerDay: number; maxPerWeek: number; windowStartHour: number; windowEndHour: number };
}

const SAMPLES: Array<{ label: string; nudge: AgentNudgeData }> = [
  { label: "Drift", nudge: PREVIEW_NUDGE },
  {
    label: "Due",
    nudge: {
      key: "due-sample",
      kind: "due",
      line: "Validate MHAR depth-router is due tomorrow.",
      sub: "No time on it this week · #3 of your three",
      go: "Open it",
      later: "Later",
      action: { type: "focus" },
    },
  },
  {
    label: "Job",
    nudge: {
      key: "job-sample",
      kind: "brief",
      line: "IM Fund wire closes in 20 hours.",
      sub: "From your Daily Brief",
      go: "Draft the follow-up",
      later: "Later",
      action: { type: "chat", prompt: "Draft a short follow-up to IM Fund about the SAFE wire." },
    },
  },
];

const REASONS: Record<string, string> = {
  ok: "Would show",
  weekend: "Silent: weekend",
  "quiet-hours": "Silent: outside work hours",
  "daily-cap": "Silent: already nudged today",
  "weekly-cap": "Silent: weekly cap reached",
  cooldown: "Silent: cooling down",
  "nothing-worth-it": "Silent: nothing worth saying",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const play = (n: AgentNudgeData) => window.dispatchEvent(new CustomEvent("papr-nudge-preview", { detail: n }));

export function NudgeDevPanel() {
  const [d, setD] = useState<NudgeDebug | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getGatewayHttpBase()}/api/nudge/debug`);
      if (!res.ok) throw new Error(res.status === 404 ? "Gateway is older than this UI — restart npm run dev" : `HTTP ${res.status}`);
      setD((await res.json()) as NudgeDebug);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => void load(), [load]);

  const reset = async () => {
    await fetch(`${getGatewayHttpBase()}/api/nudge/debug/reset`, { method: "POST" }).catch(() => undefined);
    void load();
  };

  const l = d?.ledger;
  const verdict = d ? REASONS[d.decision.reason] ?? d.decision.reason : err ? "Unavailable" : "Loading…";
  const stats = l && d
    ? [
        `Today ${l.today}/${d.rules.maxPerDay}`,
        `Week ${l.week}/${d.rules.maxPerWeek}`,
        `Ignored in a row ${l.unengaged} · gap ${l.cooldownHours}h`,
        l.nextAllowedAt ? `next allowed ${when(l.nextAllowedAt)}` : null,
        ...Object.entries(l.muted).map(([k, u]) => `${k} muted until ${when(u)}`),
      ].filter(Boolean).join(" · ")
    : err;

  return (
    <>
      <h3 className="dev-tab__heading">Nudges</h3>
      <p className="dev-tab__hint">
        Rare by design: work hours, at a breakpoint, at most once a day. Preview plays one on your agent
        in the rail without touching the ledger or the caps.
      </p>
      <div className="dev-tab__rows">
        <div className="dev-tab__row">
          <div className="dev-tab__row-text">
            <span className="dev-tab__row-label">
              {verdict}
              {d?.decision.nudge ? `: “${d.decision.nudge.line}”` : ""}
            </span>
            <span className="dev-tab__row-note">{stats}</span>
          </div>
          <button type="button" className="dev-tab__btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        {d?.candidates.map((c) => (
          <div key={c.key} className="dev-tab__row">
            <div className="dev-tab__row-text">
              <span className="dev-tab__row-label">{c.line}</span>
              <span className="dev-tab__row-note">
                {c.kind} · priority {c.priority} · from {c.source}
                {c.blocked ? ` · skipped: ${c.blocked}` : " · eligible"}
              </span>
            </div>
            <button type="button" className="dev-tab__btn" onClick={() => play(c)}>
              Preview
            </button>
          </div>
        ))}
      </div>
      <p className="dev-tab__hint" style={{ marginTop: 12 }}>
        Samples{l?.recent.length ? " · Last shown: " + l.recent.map((r) => `${when(r.at)} ${r.kind} → ${r.outcome ?? "no answer"}`).join(", ") : ""}
      </p>
      <div className="dev-tab__chips">
        {SAMPLES.map((s) => (
          <button key={s.label} type="button" className="dev-tab__chip" onClick={() => play(s.nudge)}>
            {s.label}
          </button>
        ))}
        <button type="button" className="dev-tab__chip dev-tab__chip--danger" onClick={() => void reset()}>
          Reset ledger
        </button>
      </div>
    </>
  );
}
