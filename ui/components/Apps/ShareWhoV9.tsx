/**
 * v9 Share sheet — "Who has access" (Share Bar Redesign prototype, v9).
 *
 * One row per audience; its role dropdown is the switch ("No access" = off).
 * Specific people get a role each. Link and Community add a sign-in toggle.
 * Admins edit; everyone else sees the same rows read-only with their role.
 */

import React, { useState } from "react";
import {
  ROLE_COPY,
  addGrant,
  grantKey,
  rank,
  removeGrant,
  roleOptions,
  setGrantRole,
  type AccessAudience,
  type AppAccess,
  type AppRole,
} from "../../utils/appRolesModel";
import { shareAudienceGlyphPath } from "../../utils/shareAudienceGlyphs";
import { peopleCount, signInChoice, type AudienceKey, type AudiencesDraft } from "../../utils/shareAudiencesModel";
import type { ShareAudience } from "../../utils/shareAudienceModel";
import { SharePeoplePicker, type SharePeopleMember } from "./SharePeoplePicker";

const ROWS: { key: AudienceKey | "people"; glyph: ShareAudience; label: string; sub: string }[] = [
  { key: "workspace", glyph: "team", label: "Your workspace", sub: "Everyone in this workspace" },
  { key: "people", glyph: "people", label: "Specific people", sub: "Pick a role for each person" },
  { key: "link", glyph: "link", label: "Anyone with the link", sub: "No Papr account needed unless you ask" },
  { key: "community", glyph: "public", label: "Community", sub: "Listed for anyone on Papr to find" },
];

function Glyph({ audience }: { audience: ShareAudience }) {
  return (
    <svg viewBox="0 0 16 16" width={15} height={15} aria-hidden focusable="false">
      <path d={shareAudienceGlyphPath(audience)} fill="none" stroke="currentColor" strokeWidth={1.3}
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RolePill({ value, audience, off, label, disabled, onChange }: {
  value: AppRole; audience: AccessAudience; off: boolean; label: string;
  disabled?: boolean; onChange: (r: AppRole) => void;
}) {
  if (disabled) return <span className="ss9-role">{ROLE_COPY[value].label}</span>;
  const opts = roleOptions(audience).filter((r) => r !== "none");
  return (
    <select className={`ss9-pill${rank(value) > 0 ? " ss9-pill--on" : ""}`} value={value}
      aria-label={`${label} access`} onChange={(e) => onChange(e.target.value as AppRole)}>
      {off ? <option value="none">No access</option> : null}
      {opts.map((r) => <option key={r} value={r}>{ROLE_COPY[r].label}</option>)}
    </select>
  );
}

export interface ShareWhoV9Props {
  access: AppAccess;
  draft: AudiencesDraft;
  onChange: (d: AudiencesDraft) => void;
  members: SharePeopleMember[];
  membersLoading?: boolean;
  workspaceName?: string;
  /** Under the rows: the data check, for the widest audience. */
  dataCheck?: React.ReactNode;
}

export function ShareWhoV9({ access, draft, onChange, members, membersLoading, workspaceName, dataCheck }: ShareWhoV9Props) {
  const ro = !access.canManage;
  const [adding, setAdding] = useState(false);
  const pub = access.publisherUserId;
  const others = draft.grants.filter((g) => g.userId !== pub);
  const n = peopleCount(draft, pub);
  const set = (p: Partial<AudiencesDraft>) => onChange({ ...draft, ...p });
  const nameOf = (id?: string, email?: string) => {
    const m = members.find((x) => x.userId === id);
    return { name: m?.displayName || m?.email || email || id || "", email: m?.email || email || "" };
  };

  const people = (
    <div className="ss9-sub">
      {others.map((g) => {
        const who = nameOf(g.userId, g.email);
        return (
          <div key={grantKey(g)} className="ss9-row ss9-row--person">
            <span className="ss9-av">{who.name.slice(0, 2).toUpperCase()}</span>
            <span className="ss9-who"><b>{who.name}</b>{who.email && who.email !== who.name ? <small>{who.email}</small> : null}</span>
            <RolePill value={g.role} audience="person" off={false} label={who.name} disabled={ro}
              onChange={(r) => set({ grants: setGrantRole(draft.grants, grantKey(g), r) })} />
            {ro ? null : (
              <button type="button" className="ss9-x" aria-label={`Remove ${who.name}`}
                onClick={() => set({ grants: removeGrant(draft.grants, grantKey(g)) })}>×</button>
            )}
          </div>
        );
      })}
      {!ro && adding ? (
        <SharePeoplePicker
          members={members}
          value={others.filter((g) => g.userId).map((g) => g.userId as string)}
          onChange={(ids) => {
            let grants = draft.grants.filter((g) => !g.userId || g.userId === pub || ids.includes(g.userId));
            for (const id of ids) grants = addGrant(grants, { userId: id }, "viewer");
            set({ grants });
          }}
          allowedEmails={others.filter((g) => !g.userId && g.email).map((g) => g.email as string)}
          onEmailsChange={(emails) => {
            let grants = draft.grants.filter((g) => g.userId || emails.includes(g.email ?? ""));
            for (const email of emails) grants = addGrant(grants, { email }, "viewer");
            set({ grants });
          }}
          loading={membersLoading}
          currentUserId={pub}
        />
      ) : null}
      {!ro && !adding && n > 0 ? (
        <button type="button" className="ss9-add" onClick={() => setAdding(true)}>+ Add by name or email</button>
      ) : null}
    </div>
  );

  return (
    <div className="ss9" aria-label="Who has access">
      {ro ? (
        <p className="ss6-note">You're a {ROLE_COPY[access.callerRole].label}. Only Admins can change access.</p>
      ) : null}
      {dataCheck}
      {ROWS.map((row) => {
        if (row.key === "people") {
          const open = n > 0 || adding;
          return (
            <div key="people" className={`ss9-aud${open ? " ss9-aud--on" : ""}`}>
              <div className="ss9-row">
                <span className="ss9-ico"><Glyph audience={row.glyph} /></span>
                <span className="ss9-who"><b>{row.label}</b><small>{row.sub}</small></span>
                {ro ? (
                  <span className="ss9-role">{n ? `${n} ${n === 1 ? "person" : "people"}` : "None"}</span>
                ) : (
                  <button type="button" className={`ss9-pill${n ? " ss9-pill--on" : ""}`} onClick={() => setAdding(true)}>
                    {n ? `${n} ${n === 1 ? "person" : "people"}` : "+ Add"}
                  </button>
                )}
              </div>
              {open ? people : null}
            </div>
          );
        }
        const k = row.key;
        const role = draft[k];
        const on = rank(role) > 0;
        const sub = on ? ROLE_COPY[role].sub : k === "workspace" && workspaceName ? `Everyone in ${workspaceName}` : row.sub;
        return (
          <div key={k} className={`ss9-aud${on ? " ss9-aud--on" : ""}`}>
            <div className={`ss9-row${on ? "" : " ss9-row--off"}`}>
              <span className="ss9-ico"><Glyph audience={row.glyph} /></span>
              <span className="ss9-who"><b>{row.label}</b><small>{sub}</small></span>
              <RolePill value={role} audience={k} off label={row.label} disabled={ro}
                onChange={(r) => set({ [k]: r } as Partial<AudiencesDraft>)} />
            </div>
          </div>
        );
      })}
      {signInChoice(draft) ? (
        <button type="button" role="switch" aria-checked={draft.requireSignIn} disabled={ro}
          className={`ss6-tog ss9-sign${draft.requireSignIn ? " ss6-tog--on" : ""}`}
          onClick={() => set({ requireSignIn: !draft.requireSignIn })}>
          <span className="ss6-opt-text"><b>Require Papr sign-in</b><em>For the link and Community. Know who's using it.</em></span>
          <span className="ss6-switch" aria-hidden><i /></span>
        </button>
      ) : null}
    </div>
  );
}
