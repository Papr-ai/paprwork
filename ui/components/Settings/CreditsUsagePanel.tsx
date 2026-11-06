/**
 * Billing → credits usage for orgs billed in credits: this person's allowance, the
 * org total across seats, and why they're blocked (if they are).
 */
import type { PaprCreditsSummary } from "../../../src/core/types/paprBilling";
import { usageBarPercent } from "../../../src/core/utils/paprPlanLimits";
import { formatCredits, type MemberRequestKind } from "../../../src/core/utils/paprCreditSeats";
import { useState } from "react";

const BLOCK_COPY: Record<string, string> = {
  member_cap: "You've reached your monthly limit as a member.",
  member_approval: "An admin needs to approve your usage first.",
  topup_or_upgrade: "You've used your credits for this period. Upgrade the plan, or buy more credits, to keep going.",
};

function tone(state: string): "normal" | "warning" | "exceeded" {
  if (state === "blocked") return "exceeded";
  if (state === "warn" || state === "overage") return "warning";
  return "normal";
}

function Meter(props: { label: string; used: number; grant: number; state: string; suffix?: string }) {
  const { label, used, grant, state, suffix } = props;
  const value = grant > 0 ? `${formatCredits(used)} / ${formatCredits(grant)}` : formatCredits(used);
  return (
    <div className="papr-plan__meter">
      <div className="papr-plan__meter-head">
        <span className="papr-plan__meter-label">{label}</span>
        <span className="papr-plan__meter-value">{value} credits{suffix ?? ""}</span>
      </div>
      <div className="papr-plan__meter-track">
        <div className="papr-plan__meter-fill" data-tone={tone(state)}
          style={{ width: `${grant > 0 ? usageBarPercent(used, grant) : 0}%` }} />
      </div>
    </div>
  );
}

/** What a blocked member can ask for, by block reason. */
const ASKS: Record<string, Array<{ kind: MemberRequestKind; label: string; primary?: boolean }>> = {
  member_cap: [{ kind: "limit", label: "Ask for a higher limit" }, { kind: "seat", label: "Ask to become a builder", primary: true }],
  member_approval: [{ kind: "access", label: "Ask for access", primary: true }],
};

function AskButtons({ reason, requested }: { reason: string; requested: string[] }) {
  const [sent, setSent] = useState<string[]>(requested);
  const [error, setError] = useState<string | null>(null);
  const asks = ASKS[reason] ?? [];
  if (!asks.length) return null;
  const ask = async (kind: MemberRequestKind) => {
    setError(null);
    const r = await window.electronAPI.papr.requestMember({ kind });
    if (r.success) setSent((s) => [...s, kind]);
    else setError(r.error ?? "Couldn't send the request");
  };
  return (
    <div className="papr-plan__asks">
      {asks.map((a) => sent.includes(a.kind) ? (
        <span key={a.kind} className="papr-plan__asked">Requested · {a.label.replace(/^Ask (for |to )?/, "")}</span>
      ) : (
        <button key={a.kind} type="button" onClick={() => void ask(a.kind)}
          className={a.primary ? "papr-plan__primary-btn" : "papr-plan__secondary-btn"}>{a.label}</button>
      ))}
      {error && <span className="papr-plan__hint">{error}</span>}
    </div>
  );
}

export function CreditsUsagePanel({ credits }: { credits: PaprCreditsSummary }) {
  const { you, org } = credits;
  const blocked = you.state === "blocked";
  const memberNote = !you.seat
    ? you.memberCap ? ` · pay as you go, up to ${formatCredits(you.memberCap)}/mo` : " · pay as you go"
    : "";
  return (
    <>
      {blocked ? (
        <div className="papr-plan__alert" data-tone="exceeded">
          {BLOCK_COPY[you.reason ?? ""] ?? "Your monthly credits are used up."} Local chat still works.
          {!you.seat && <AskButtons reason={you.reason ?? ""} requested={you.requests ?? []} />}
        </div>
      ) : you.state === "overage" ? (
        <div className="papr-plan__alert" data-tone="warning">
          Past your included credits. Usage continues from your credit balance.
        </div>
      ) : null}
      <Meter label="Your credits this period" used={you.used} grant={you.seat ? you.grant : 0}
        state={you.state} suffix={memberNote} />
      {org && org.seats > 1 ? (
        <Meter label={`Organization (${org.seats} seats)`} used={org.used} grant={org.grant} state={org.state} />
      ) : null}
      {credits.topupBalanceUsd != null ? (
        <p className="papr-plan__hint">Credit balance: ${credits.topupBalanceUsd.toFixed(2)}</p>
      ) : null}
    </>
  );
}
