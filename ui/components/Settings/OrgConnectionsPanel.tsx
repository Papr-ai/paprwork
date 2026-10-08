/**
 * OrgConnectionsPanel — admins only, inside Connections.
 *
 * Requests first (that's what a notification brings you here for), then the
 * org rules: which services members may connect, widest sharing, most Pen
 * access, and who may set up services that need a one-time OAuth app.
 */
import { useEffect, useRef, useState } from "react";
import type { ConnectionRequest, OrgConnectionPolicy, useOrgConnections } from "../../hooks/useOrgConnections";
import { CONNECTIONS_REQUESTS_EVENT } from "../../stores/proposalNoticeListener";

type Org = ReturnType<typeof useOrgConnections>;

const OPTIONS: { key: keyof OrgConnectionPolicy; label: string; hint: string; values: [string, string][] }[] = [
  {
    key: "mode",
    label: "Members can connect",
    hint: "Approved only: members request a service and you approve it here.",
    values: [["all", "Any service"], ["approved", "Approved only"], ["none", "Nothing (admins only)"]],
  },
  {
    key: "maxShare",
    label: "Widest a member can share a connection",
    hint: "Applies to API keys too.",
    values: [["user", "Only themselves"], ["members", "Selected people"], ["namespace", "Their team"], ["org", "The whole org"]],
  },
  {
    key: "maxPenAccess",
    label: "Most access Pen can get",
    hint: "Members can choose less, never more.",
    values: [["read", "Read only"], ["ask", "Ask before changes"], ["full", "Full access"]],
  },
  {
    key: "setupBy",
    label: "Who can set up services that need setup",
    hint: "HubSpot, Slack, GitHub and similar need a one-time OAuth app.",
    values: [["admins", "Admins only"], ["anyone", "Anyone"]],
  },
];

function RequestRow({ r, org }: { r: ConnectionRequest; org: Org }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const who = r.requesters.length === 1 ? "1 person" : `${r.requesters.length} people`;
  const notes = r.requesters.map((q) => q.note).filter(Boolean);
  return (
    <li className="org-conn__req">
      <div className="org-conn__req-main">
        <b>{r.serverName}</b>
        <span className="org-conn__muted">Requested by {who}</span>
        {notes.map((n, i) => (
          <q key={i} className="org-conn__note">{n}</q>
        ))}
      </div>
      {declining ? (
        <div className="org-conn__req-actions">
          <input
            className="form-input"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="button" className="settings-btn settings-btn--secondary" onClick={() => setDeclining(false)}>
            Back
          </button>
          <button type="button" className="settings-btn settings-btn--danger" onClick={() => void org.decide(r.id, false, reason)}>
            Decline
          </button>
        </div>
      ) : (
        <div className="org-conn__req-actions">
          <button type="button" className="settings-btn settings-btn--secondary" onClick={() => setDeclining(true)}>
            Decline
          </button>
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void org.decide(r.id, true)}>
            Approve
          </button>
        </div>
      )}
    </li>
  );
}

export function OrgConnectionsPanel({ org }: { org: Org }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const show = () => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.addEventListener(CONNECTIONS_REQUESTS_EVENT, show);
    return () => window.removeEventListener(CONNECTIONS_REQUESTS_EVENT, show);
  }, []);

  if (!org.isAdmin || !org.policy) return null;
  const policy = org.policy;

  return (
    <section className="org-conn" ref={ref} aria-label="Org settings">
      <h3 className="connections-view__group">Org settings</h3>

      <div className="org-conn__card">
        <h4>Requests{org.requests.length ? ` (${org.requests.length})` : ""}</h4>
        {org.requests.length === 0 ? (
          <p className="org-conn__muted">No pending requests.</p>
        ) : (
          <ul className="org-conn__reqs">
            {org.requests.map((r) => (
              <RequestRow key={r.id} r={r} org={org} />
            ))}
          </ul>
        )}
      </div>

      <div className="org-conn__card">
        <h4>Rules</h4>
        {OPTIONS.map((o) => (
          <label key={o.key} className="org-conn__rule">
            <span>
              {o.label}
              <small className="org-conn__muted">{o.hint}</small>
            </span>
            <select
              className="form-input"
              aria-label={o.label}
              value={String(policy[o.key])}
              onChange={(e) => void org.updatePolicy({ [o.key]: e.target.value } as Partial<OrgConnectionPolicy>)}
            >
              {o.values.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ))}
        {policy.mode === "approved" && (
          <p className="org-conn__muted">
            Approved: {policy.approved.length ? policy.approved.join(", ") : "none yet"}. Connections made before this
            rule keep working.
          </p>
        )}
        {org.error && <p className="org-conn__error">{org.error}</p>}
      </div>
    </section>
  );
}
