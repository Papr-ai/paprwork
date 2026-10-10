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
    label: "Services members can connect",
    hint: "With Approved, members request one and you decide here.",
    values: [["all", "Any"], ["approved", "Approved"], ["none", "None"]],
  },
  {
    key: "maxShare",
    label: "Widest a member can share",
    hint: "Connections and API keys alike.",
    values: [["user", "Only me"], ["members", "People"], ["namespace", "Team"], ["org", "Org"]],
  },
  {
    key: "maxPenAccess",
    label: "Most access Pen can get",
    hint: "Members can choose less, never more.",
    values: [["read", "Read"], ["ask", "Ask first"], ["full", "Full"]],
  },
  {
    key: "setupBy",
    label: "Who can set up services",
    hint: "HubSpot, Slack, GitHub and similar need a one-time app.",
    values: [["admins", "Admins"], ["anyone", "Anyone"]],
  },
];

function RequestRow({ r, org }: { r: ConnectionRequest; org: Org }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const who = r.requesters.length === 1 ? "1 person" : `${r.requesters.length} people`;
  const notes = r.requesters.map((q) => q.note).filter(Boolean);
  return (
    <li className="svc-row org-conn__req">
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

function Seg({ label, value, options, onPick }: { label: string; value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <div className="org-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "is-on" : ""} onClick={() => value !== v && onPick(v)}>
          {l}
        </button>
      ))}
    </div>
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
      {org.requests.length > 0 && (
        <section className="svc-sec">
          <div className="svc-sec__h"><h3>Requests</h3><span>{org.requests.length}</span></div>
          <ul className="svc-list org-conn__reqs">
            {org.requests.map((r) => (
              <RequestRow key={r.id} r={r} org={org} />
            ))}
          </ul>
        </section>
      )}

      <section className="svc-sec">
        <div className="svc-sec__h"><h3>Org rules</h3><span className="org-conn__hnote">Apply to everyone in your org</span></div>
        <div className="svc-list">
          {OPTIONS.map((o) => (
            <div key={o.key} className="org-rule">
              <div className="svc-row__text">
                <b className="svc-row__name">{o.label}</b>
                <span className="org-conn__muted">{o.hint}</span>
              </div>
              <Seg label={o.label} value={String(policy[o.key])} options={o.values} onPick={(v) => void org.updatePolicy({ [o.key]: v } as Partial<OrgConnectionPolicy>)} />
            </div>
          ))}
          {policy.mode === "approved" && (
            <p className="org-conn__muted org-conn__foot">
              Approved: {policy.approved.length ? policy.approved.join(", ") : "none yet"}. Connections made before this rule keep working.
            </p>
          )}
        </div>
        {org.error && <p className="org-conn__error">{org.error}</p>}
      </section>
    </section>
  );
}
