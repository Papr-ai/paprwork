/**
 * Billing → Members (owners/admins, credits orgs): who may use credits, the monthly limit
 * per member, and requests from members (access, a seat, a higher limit).
 * Approving a seat makes them a builder now (prorated, price on the button). Approving a
 * higher limit is prefilled at 2x their current limit and can be edited.
 */
import { useEffect, useState } from "react";
import {
  describeSeatChange, formatCredits, PAYG, type BuildersView, type MemberRequest,
} from "../../../src/core/utils/paprCreditSeats";
import { USD_PER_CREDIT } from "../../../src/core/types/paprCreditPlans";

/** Limits are edited in dollars; credits are shown next to them. */
const toUsd = (credits: number) => String(Math.round(credits * USD_PER_CREDIT));
const toCredits = (usd: string) => Math.round(Number(usd) / USD_PER_CREDIT);
const usdOnly = (v: string) => v.replace(/[^0-9]/g, "");

const ASKED: Record<string, string> = { access: "asked to use credits", seat: "asked to become a builder", limit: "asked for a higher limit" };

export function MemberRequestsCard(props: { names: Record<string, string>; onChanged?: () => void }) {
  const [view, setView] = useState<BuildersView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [orgCap, setOrgCap] = useState("");

  const load = async () => {
    const r = await window.electronAPI.papr.getBuilderSeats();
    if (r.success && r.view) { setView(r.view); setOrgCap(toUsd(r.view.memberCap)); }
  };
  useEffect(() => { void load(); }, []);
  if (!view) return null;

  const run = async (id: string, fn: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(id); setError(null);
    const r = await fn();
    setBusy(null);
    if (!r.success) setError(r.error ?? "Something went wrong");
    await load(); props.onChanged?.();
  };
  const name = (u: string) => props.names[u] ?? "A member";
  const seatPrice = view.plan ? describeSeatChange(view, PAYG, view.plan) : null;
  const decide = (q: MemberRequest, approve: boolean) => run(`${q.userId}:${q.kind}`, () =>
    window.electronAPI.papr.decideMemberRequest({
      userId: q.userId, kind: q.kind, approve,
      capCredits: approve && q.kind === "limit" ? toCredits(caps[q.userId] ?? toUsd(q.suggestedCapCredits ?? 0)) : undefined,
      plan: approve && q.kind === "seat" ? view.plan ?? undefined : undefined,
    }));
  const requests = view.memberRequests ?? [];
  const policy = view.memberPolicy ?? "auto";
  const prorated = (seatPrice?.summary.match(/\$\d+/)?.[0]) ?? null;

  return (
    <div className="papr-plan__members">
      <div className="papr-plan__members-head">Members</div>
      {requests.map((q) => (
        <div key={`${q.userId}:${q.kind}`} className="papr-plan__request">
          <div className="papr-plan__request-text">
            <strong>{name(q.userId)}</strong> {ASKED[q.kind]}
            {q.kind === "limit" && <span className="papr-plan__hint"> · now ${toUsd(q.currentCapCredits ?? 0)}/mo</span>}
          </div>
          {q.kind === "limit" && (() => {
            const usd = caps[q.userId] ?? toUsd(q.suggestedCapCredits ?? 0);
            return <MoneyInput label="New monthly limit in dollars" usd={usd} onChange={(v) => setCaps({ ...caps, [q.userId]: v })} />;
          })()}
          <button type="button" className="papr-plan__secondary-btn" disabled={busy !== null} onClick={() => void decide(q, false)}>Decline</button>
          <button type="button" className="papr-plan__primary-btn" disabled={busy !== null} onClick={() => void decide(q, true)}>
            {q.kind === "seat" ? `Approve${prorated ? ` · ${prorated}/mo` : ""}` : "Approve"}
          </button>
        </div>
      ))}
      {requests.some((q) => q.kind === "seat") && seatPrice && <p className="papr-plan__hint">{seatPrice.summary}</p>}
      <label className="papr-plan__member-row">
        <span>Members can use credits</span>
        <select className="papr-plan__select" value={policy} disabled={busy !== null}
          onChange={(e) => void run("policy", () => window.electronAPI.papr.setMemberPolicy({ policy: e.target.value as "auto" | "approve" }))}>
          <option value="auto">Right away</option>
          <option value="approve">After an admin approves</option>
        </select>
      </label>
      <label className="papr-plan__member-row">
        <span>Monthly limit per member</span>
        <MoneyInput label="Monthly limit per member in dollars" usd={orgCap} onChange={setOrgCap}
          onBlur={() => orgCap !== "" && toCredits(orgCap) !== Math.round(view.memberCap) &&
            void run("cap", () => window.electronAPI.papr.setMemberCap({ capCredits: toCredits(orgCap) }))} />
      </label>
      {error && <p className="papr-plan__hint">{error}</p>}
    </div>
  );
}

/** "$ [25] /mo · 25K credits": people set money, the credit count is shown for reference. */
function MoneyInput(props: { label: string; usd: string; onChange: (usd: string) => void; onBlur?: () => void }) {
  const credits = props.usd === "" ? null : toCredits(props.usd);
  return (
    <span className="papr-plan__money">
      <span className="papr-plan__money-field">
        <span aria-hidden="true">$</span>
        <input inputMode="numeric" aria-label={props.label} value={props.usd}
          onChange={(e) => props.onChange(usdOnly(e.target.value))} onBlur={props.onBlur} />
        <span className="papr-plan__money-unit">/mo</span>
      </span>
      {credits !== null && <span className="papr-plan__money-credits">{formatCredits(credits)} credits</span>}
    </span>
  );
}
