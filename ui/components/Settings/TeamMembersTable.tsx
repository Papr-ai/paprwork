/**
 * Team members: Access (what they can do) and Plan (what they cost) as two separate columns.
 *
 * No browser dialogs. A change that charges now (new seat, upgrade, promoting a pay-as-you-go
 * member to admin) opens an inline confirm on the row with the price. A change that charges
 * nothing now (downgrade, back to pay as you go) waits a few seconds with Undo, then applies:
 * applying and reverting would double-charge, so it is held, not reverted.
 */
import { useEffect, useRef, useState } from "react";
import {
  WORKSPACE_ROLE_PRIORITY,
  canModifyMemberRole,
  formatWorkspaceRoleLabel,
  normalizeWorkspaceRole,
  type WorkspaceRoleName,
} from "../../../src/core/utils/workspaceRolePermissions";
import {
  PAYG,
  describeSeatChange,
  formatCredits,
  isBuilderRoles,
  monthlySeatTotal,
  planLabel,
  seatValue,
  usageByUser,
  type BuildersView,
} from "../../../src/core/utils/paprCreditSeats";
import { UserAvatar } from "../common/UserAvatar";
import "./TeamMembersTable.css";

export interface TeamMember {
  objectId: string;
  user: { objectId: string; email: string; displayName: string; profileImageUrl?: string; role: string };
}

type Pending =
  | { userId: string; kind: "plan"; from: string; to: string }
  | { userId: string; kind: "access"; role: WorkspaceRoleName; plan: string };

const UNDO_MS = 6000;
const isAdminRole = (r: string) => r === "owner" || r === "admin";

export function TeamMembersTable(props: {
  members: TeamMember[];
  currentUserId: string | null;
  currentUserRole: string;
  loading: boolean;
  busyUserId: string | null;
  seatsView: BuildersView | null;
  /** to = plan key or PAYG. Already confirmed by the user. */
  onPlanChange: (member: TeamMember, from: string, to: string) => void;
  /** plan = put them on this seat plan first (they had none). Already confirmed. */
  onAccessChange: (member: TeamMember, role: WorkspaceRoleName, plan?: string) => void;
}) {
  const { members, currentUserId, currentUserRole, loading, busyUserId, seatsView } = props;
  const [pending, setPending] = useState<Pending | null>(null);
  const [held, setHeld] = useState<{ member: TeamMember; from: string; to: string; summary: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const propsRef = useRef(props);
  propsRef.current = props;
  const usage = usageByUser(seatsView);
  const options = seatsView?.planOptions ?? [];

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const h = heldRef.current;
    setHeld(null);
    if (h) propsRef.current.onPlanChange(h.member, h.from, h.to);
  };
  // Leaving the tab applies what was chosen (it was the user's decision; Undo just expired early).
  useEffect(() => () => { if (heldRef.current) flush(); }, []);

  const pickPlan = (member: TeamMember, from: string, to: string) => {
    if (!seatsView || from === to) return;
    if (held) flush();
    const change = describeSeatChange(seatsView, from, to);
    if (change.chargesNow) {
      setPending({ userId: member.user.objectId, kind: "plan", from, to });
      return;
    }
    setPending(null);
    setHeld({ member, from, to, summary: change.summary });
    timer.current = setTimeout(flush, UNDO_MS);
  };

  const pickAccess = (member: TeamMember, builder: boolean, role: WorkspaceRoleName) => {
    // Owners/admins always hold a seat: promoting someone without one = pick their plan.
    if (seatsView && options.length && isAdminRole(role) && !builder) {
      setPending({ userId: member.user.objectId, kind: "access", role, plan: "" });
      return;
    }
    setPending(null);
    props.onAccessChange(member, role);
  };

  return (
    <div className="team-table">
      <div className="team-table__head">
        <span>Person</span>
        <span>Access</span>
        {seatsView && <span>Plan</span>}
      </div>
      <ul className="team-table__rows">
        {members.map((member) => {
          const id = member.user.objectId;
          const role = normalizeWorkspaceRole(member.user.role);
          const row = usage.get(id);
          const builder = seatsView ? isBuilderRoles(row?.roles ?? []) || isAdminRole(role) : false;
          const plan = seatValue(seatsView, row, builder);
          const canEditRole = currentUserId !== null &&
            canModifyMemberRole({ currentUserId, currentUserRole, targetMember: member, members });
          const busy = busyUserId === id;
          const until = row?.planUntilPeriodEnd
            ? (options.find((o) => o.key === row.planUntilPeriodEnd)?.name ?? row.planUntilPeriodEnd)
            : null;
          const rowPending = pending?.userId === id ? pending : null;
          const rowHeld = held?.member.user.objectId === id ? held : null;
          const shownPlan = rowHeld?.to ?? (rowPending?.kind === "plan" ? rowPending.to : plan);
          return (
            <li key={member.objectId} className={`team-table__row${rowPending ? " team-table__row--open" : ""}`}>
              <div className="team-table__main">
                <div className="team-table__person">
                  <UserAvatar imageUrl={member.user.profileImageUrl} displayName={member.user.displayName}
                    email={member.user.email} size={28} />
                  <div className="team-table__who">
                    <span className="team-table__name">{member.user.displayName}</span>
                    <span className="team-table__sub">
                      {member.user.email}
                      {seatsView && row && row.used > 0 && (
                        <> · {formatCredits(row.used)}{builder ? ` / ${formatCredits(row.grant)}` : ""} credits
                          {row.overageUsd > 0 ? ` · $${row.overageUsd.toFixed(2)}` : ""}</>
                      )}
                    </span>
                  </div>
                </div>
                {canEditRole ? (
                  <select className="team-table__select" value={rowPending?.kind === "access" ? rowPending.role : role}
                    disabled={loading || busy} aria-label={`Access for ${member.user.displayName}`}
                    onChange={(e) => pickAccess(member, builder, e.target.value as WorkspaceRoleName)}>
                    {WORKSPACE_ROLE_PRIORITY.map((r) => <option key={r} value={r}>{formatWorkspaceRoleLabel(r)}</option>)}
                  </select>
                ) : (
                  <span className="team-table__static">{formatWorkspaceRoleLabel(role)}</span>
                )}
                {seatsView && (options.length ? (
                  <select className={`team-table__select${builder ? " team-table__select--paid" : ""}`}
                    value={shownPlan} disabled={loading || busy || !!rowPending}
                    aria-label={`Plan for ${member.user.displayName}`}
                    onChange={(e) => pickPlan(member, plan, e.target.value)}>
                    {!isAdminRole(role) && <option value={PAYG}>Pay as you go</option>}
                    {options.map((o) => <option key={o.key} value={o.key}>{planLabel(seatsView, o.key)}</option>)}
                  </select>
                ) : (
                  <span className="team-table__static">{builder ? planLabel(seatsView, plan) : "Pay as you go"}</span>
                ))}
              </div>
              {until && !rowPending && !rowHeld && (
                <p className="team-table__note">Keeps {until} credits until this period ends.</p>
              )}
              {rowHeld && (
                <p className="team-table__note team-table__note--held">
                  {rowHeld.summary}
                  <button type="button" className="team-table__link" onClick={() => {
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = null;
                    setHeld(null);
                  }}>Undo</button>
                </p>
              )}
              {rowPending?.kind === "plan" && seatsView && (
                <div className="team-table__confirm">
                  <span>{describeSeatChange(seatsView, rowPending.from, rowPending.to).summary}</span>
                  <button type="button" className="team-table__btn" onClick={() => setPending(null)}>Cancel</button>
                  <button type="button" className="team-table__btn team-table__btn--primary" onClick={() => {
                    setPending(null);
                    props.onPlanChange(member, rowPending.from, rowPending.to);
                  }}>Confirm</button>
                </div>
              )}
              {rowPending?.kind === "access" && seatsView && (
                <div className="team-table__confirm">
                  <span>
                    {formatWorkspaceRoleLabel(rowPending.role)}s have a paid seat. Plan:{" "}
                    <select className="team-table__select team-table__select--inline" value={rowPending.plan}
                      onChange={(e) => setPending({ ...rowPending, plan: e.target.value })}>
                      <option value="" disabled>Pick a plan…</option>
                      {options.map((o) => <option key={o.key} value={o.key}>{planLabel(seatsView, o.key)}</option>)}
                    </select>
                    {rowPending.plan && <> {describeSeatChange(seatsView, PAYG, rowPending.plan).summary}</>}
                  </span>
                  <button type="button" className="team-table__btn" onClick={() => setPending(null)}>Cancel</button>
                  <button type="button" className="team-table__btn team-table__btn--primary" disabled={!rowPending.plan}
                    onClick={() => {
                      setPending(null);
                      props.onAccessChange(member, rowPending.role, rowPending.plan);
                    }}>Confirm</button>
                </div>
              )}
            </li>
          );
        })}
        {!loading && members.length === 0 && <li className="team-table__empty">No team members loaded yet.</li>}
      </ul>
      {seatsView && (
        <p className="team-table__total">
          <strong>{seatsView.seats}</strong> paid seat{seatsView.seats === 1 ? "" : "s"} · ${monthlySeatTotal(seatsView)}/mo.
          {" "}Pay-as-you-go people pay per credit, up to {formatCredits(seatsView.memberCap)}/mo each. One bill.
          {!seatsView.seatsInSync && " Billing is syncing."}
        </p>
      )}
    </div>
  );
}
