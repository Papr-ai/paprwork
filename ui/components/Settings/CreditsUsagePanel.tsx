/**
 * Billing → credits usage for orgs billed in credits: this person's allowance, the
 * org total across seats, and why they're blocked (if they are).
 */
import type { PaprCreditsSummary } from "../../../src/core/types/paprBilling";
import { usageBarPercent } from "../../../src/core/utils/paprPlanLimits";
import { formatCredits } from "../../../src/core/utils/paprCreditSeats";

const BLOCK_COPY: Record<string, string> = {
  member_cap: "You've reached your monthly limit as a member. Ask an admin to make you a builder or raise your limit.",
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
