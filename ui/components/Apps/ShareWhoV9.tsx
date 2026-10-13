/**
 * v9 Share sheet — "People with access" + "Public access" (Share Bar Redesign prototype, v9).
 *
 * People: the owner first, then "Everyone in <workspace>" (a gray + until given a
 * role), then named people. Public: a gray + until on; then the line under the
 * title picks Anyone with the link / Listed in Community, and the role sits on the
 * right. Every role menu ends with "Remove access" — no × buttons.
 * Admins edit; everyone else sees the same rows read-only.
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
  type AppAccess,
  type AppRole,
} from "../../utils/appRolesModel";
import { shareAudienceGlyphPath } from "../../utils/shareAudienceGlyphs";
import {
  publicMode,
  publicRole,
  setPublicMode,
  setPublicRole,
  signInChoice,
  type AudiencesDraft,
  type PublicMode,
} from "../../utils/shareAudiencesModel";
import type { ShareAudience } from "../../utils/shareAudienceModel";
import { SharePeoplePicker, type SharePeopleMember } from "./SharePeoplePicker";
import { ShareRoleMenu } from "./ShareRoleMenu";

const opts = (a: "workspace" | "person" | "link") => roleOptions(a).filter((r) => r !== "none");

function Glyph({ audience }: { audience: ShareAudience }) {
  return (
    <svg viewBox="0 0 16 16" width={15} height={15} aria-hidden focusable="false">
      <path d={shareAudienceGlyphPath(audience)} fill="none" stroke="currentColor" strokeWidth={1.3}
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Plus({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="ss9-plus" aria-label={`Give ${label} access`} title="Give access" onClick={onClick}>+</button>
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
  const set = (p: Partial<AudiencesDraft>) => onChange({ ...draft, ...p });
  const nameOf = (id?: string, email?: string) => {
    const m = members.find((x) => x.userId === id);
    return { name: m?.displayName || m?.email || email || id || "", email: m?.email || email || "" };
  };
  const owner = nameOf(pub);
  const ws = draft.workspace;
  const wsOn = rank(ws) > 0;
  const team = workspaceName ? `Everyone in ${workspaceName}` : "Everyone in your workspace";
  const mode = publicMode(draft);
  const pubOn = mode !== "off";
  const avatar = (name: string) => <span className="ss9-av">{name.slice(0, 2).toUpperCase()}</span>;

  const picker = !ro && adding ? (
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
  ) : null;

  const where = !pubOn ? <small>No access</small> : ro ? (
    <small>{mode === "community" ? "Listed in Community" : "Anyone with the link"}</small>
  ) : (
    <select className="ss9-where" aria-label="Who can open it" value={mode}
      onChange={(e) => onChange(setPublicMode(draft, e.target.value as PublicMode))}>
      <option value="link">Anyone with the link</option>
      <option value="community">Listed in Community</option>
    </select>
  );

  return (
    <div className="ss9" aria-label="Who has access">
      {ro ? (
        <p className="ss6-note">You're a {ROLE_COPY[access.callerRole].label}. Only Admins can change access.</p>
      ) : null}
      {dataCheck}

      <h6 className="ss9-h">People with access</h6>
      <div className="ss9-row">
        {avatar(owner.name || "Owner")}
        <span className="ss9-who"><b>{owner.name || "Owner"}</b><small>Owner</small></span>
        <span className="ss9-role">Admin</span>
      </div>
      <div className={`ss9-row${wsOn ? "" : " ss9-row--off"}`}>
        <span className="ss9-ico"><Glyph audience="team" /></span>
        <span className="ss9-who"><b>{team}</b><small>{!wsOn ? "No access" : members.length ? `${members.length} members` : ROLE_COPY[ws].sub}</small></span>
        {wsOn ? (
          <ShareRoleMenu value={ws} options={opts("workspace")} label={team} readOnly={ro}
            onChange={(r) => set({ workspace: r })} onRemove={() => set({ workspace: "none" })} />
        ) : ro ? <span className="ss9-role">No access</span> : <Plus label={team} onClick={() => set({ workspace: "viewer" })} />}
      </div>
      {others.map((g) => {
        const who = nameOf(g.userId, g.email);
        return (
          <div key={grantKey(g)} className="ss9-row">
            {avatar(who.name)}
            <span className="ss9-who"><b>{who.name}</b>{who.email && who.email !== who.name ? <small>{who.email}</small> : null}</span>
            <ShareRoleMenu value={g.role} options={opts("person")} label={who.name} readOnly={ro}
              onChange={(r: AppRole) => set({ grants: setGrantRole(draft.grants, grantKey(g), r) })}
              onRemove={() => set({ grants: removeGrant(draft.grants, grantKey(g)) })} />
          </div>
        );
      })}
      {picker}
      {!ro && !adding ? (
        <button type="button" className="ss9-add" onClick={() => setAdding(true)}>+ Add people</button>
      ) : null}

      <h6 className="ss9-h">Public access</h6>
      <div className={`ss9-row${pubOn ? "" : " ss9-row--off"}`}>
        <span className="ss9-ico"><Glyph audience={mode === "community" ? "public" : "link"} /></span>
        <span className="ss9-who"><b>Public access</b>{where}</span>
        {pubOn ? (
          <ShareRoleMenu value={publicRole(draft)} label="Public"
            options={opts("link")} readOnly={ro}
            onChange={(r) => onChange(setPublicRole(draft, r))} onRemove={() => onChange(setPublicMode(draft, "off"))} />
        ) : ro ? <span className="ss9-role">No access</span> : <Plus label="public" onClick={() => onChange(setPublicMode(draft, "link"))} />}
      </div>
      {signInChoice(draft) ? (
        <button type="button" role="switch" aria-checked={draft.requireSignIn} disabled={ro}
          className={`ss6-tog ss9-sign${draft.requireSignIn ? " ss6-tog--on" : ""}`}
          onClick={() => set({ requireSignIn: !draft.requireSignIn })}>
          <span className="ss6-opt-text"><b>Require Papr sign-in</b><em>Know who's using it.</em></span>
          <span className="ss6-switch" aria-hidden><i /></span>
        </button>
      ) : null}
    </div>
  );
}
