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

const ASKED: Record<string, string> = { access: "asked to use credits", seat: "asked to become a builder", limit: "asked for a higher limit" };

export function MemberRequestsCard(props: { names: Record<string, string>; onChanged?: () => void }) {
  const [view, setView] = useState<BuildersView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [orgCap, setOrgCap] = useState("");

  const load = async () => {
    const r = await window.electronAPI.papr.getBuilderSeats();
    if (r.success && r.view) { setView(r.view); setOrgCap(String(Math.round(r.view.memberCap))); }
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
      capCredits: approve && q.kind === "limit" ? Number(caps[q.userId] ?? q.suggestedCapCredits) : undefined,
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
            {q.kind === "limit" && <span className="papr-plan__hint"> · now {formatCredits(q.currentCapCredits ?? 0)} credits/mo</span>}
          </div>
          {q.kind === "limit" && (
            <input className="papr-plan__cap-input" inputMode="numeric" aria-label="New monthly limit in credits"
              value={caps[q.userId] ?? String(Math.round(q.suggestedCapCredits ?? 0))}
              onChange={(e) => setCaps({ ...caps, [q.userId]: e.target.value.replace(/[^0-9]/g, "") })} />
          )}
          <button type="button" className="papr-plan__secondary-btn" disabled={busy !== null} onClick={() => void decide(q, false)}>Decline</button>
          <button type="button" className="papr-plan__primary-btn" disabled={busy !== null} onClick={() => void decide(q, true)}>
            {q.kind === "seat" ? `Approve${prorated ? ` · ${prorated}/mo` : ""}` : "Approve"}
          </button>
        </div>
      ))}
      {requests.some((q) => q.kind === "seat") && seatPrice && <p className="papr-plan__hint">{seatPrice.summary}</p>}
      <label className="papr-plan__member-row">
        <span>Members can use credits</span>
        <select value={policy} disabled={busy !== null}
          onChange={(e) => void run("policy", () => window.electronAPI.papr.setMemberPolicy({ policy: e.target.value as "auto" | "approve" }))}>
          <option value="auto">Right away</option>
          <option value="approve">After an admin approves</option>
        </select>
      </label>
      <label className="papr-plan__member-row">
        <span>Monthly limit per member</span>
        <span>
          <input className="papr-plan__cap-input" inputMode="numeric" value={orgCap} aria-label="Monthly limit per member in credits"
            onChange={(e) => setOrgCap(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={() => Number(orgCap) !== Math.round(view.memberCap) && orgCap !== "" &&
              void run("cap", () => window.electronAPI.papr.setMemberCap({ capCredits: Number(orgCap) }))} /> credits
        </span>
      </label>
      {error && <p className="papr-plan__hint">{error}</p>}
    </div>
  );
}
