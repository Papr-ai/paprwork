/**
 * "Who has access" — roles per audience (GitHub-style), plan v9 §8.
 *
 * Loads GET /api/cloud/apps/{id}/access, edits a draft, and saves only the
 * changed fields with PUT (Admins only; the server enforces caps and keeps the
 * publisher Admin). Everyone else sees it read-only with their own role.
 * A non-publisher Admin also picks who can open it here, because the bar's
 * publish call is still the publisher's.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ROLE_COPY,
  UPLOAD_MAX_MB_CHOICES,
  accessPatch,
  addGrant,
  editableGrants,
  grantKey,
  isLinkVisibility,
  removeGrant,
  roleOptions,
  setGrantRole,
  type AccessAudience,
  type AccessVisibility,
  type AppAccess,
  type AppRole,
} from "../../utils/appRolesModel";
import { fetchAppAccess, saveAppAccess } from "../../utils/appAccessApi";
import { SharePeoplePicker, type SharePeopleMember } from "./SharePeoplePicker";
import { AccessRow, RoleSelect, VISIBILITY_CHOICES } from "./ShareAccessRows";

export interface ShareAccessPanelProps {
  appId: string;
  members: SharePeopleMember[];
  membersLoading?: boolean;
  onClose: () => void;
  /** After a save, so the bar can refresh its live config. */
  onSaved?: (access: AppAccess) => void;
}

export function ShareAccessPanel(props: ShareAccessPanelProps) {
  const { appId } = props;
  const [live, setLive] = useState<AppAccess | null>(null);
  const [draft, setDraft] = useState<AppAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAppAccess(appId)
      .then((a) => {
        if (cancelled) return;
        if (!a) setError("Publish the app to manage who has access.");
        setLive(a);
        setDraft(a);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const patch = useMemo(() => (live && draft ? accessPatch(live, draft) : {}), [live, draft]);
  const dirty = Object.keys(patch).length > 0;
  if (!draft || !live) {
    return <p className="ss6-note">{error ?? "Loading access…"}</p>;
  }

  const edit = draft.canManage && !saving;
  const set = (p: Partial<AppAccess>) => setDraft({ ...draft, ...p });
  const people = editableGrants(draft);
  const isPublisherView = live.callerRole === "admin" && live.admins[0] === live.publisherUserId;
  const nameOf = (key: string) => {
    const m = props.members.find((x) => x.userId === key);
    return m ? m.displayName || m.email : key;
  };
  const select = (audience: AccessAudience, value: AppRole, on: (r: AppRole) => void) => (
    <RoleSelect value={value} options={roleOptions(audience)} disabled={!edit} onChange={on} />
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await saveAppAccess(appId, patch);
      setLive(next);
      setDraft(next);
      props.onSaved?.(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div aria-label="Who has access">
      <h6 className="ss6-h">Who has access</h6>
      {!draft.canManage ? (
        <p className="ss6-note">
          You're a {ROLE_COPY[draft.callerRole].label}. Only Admins can change access.
        </p>
      ) : null}

      {draft.canManage && !isPublisherView ? (
        <AccessRow label="Who can open it">
          <select
            className="ss6-role"
            value={draft.visibility}
            disabled={!edit}
            onChange={(e) => set({ visibility: e.target.value as AccessVisibility })}
          >
            {VISIBILITY_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </AccessRow>
      ) : null}

      {draft.visibility === "team" ? (
        <AccessRow label="Workspace">
          {select("workspace", draft.workspaceRole, (r) => set({ workspaceRole: r }))}
        </AccessRow>
      ) : null}

      <AccessRow label="People" sub={people.length ? undefined : "Add by name or email"} />
      <div className="ss6-access-people">
        {edit ? (
          <SharePeoplePicker
            members={props.members}
            value={people.filter((g) => g.userId).map((g) => g.userId as string)}
            onChange={(ids) => {
              let grants = draft.grants.filter((g) => !g.userId || ids.includes(g.userId) || g.userId === draft.publisherUserId);
              for (const id of ids) grants = addGrant(grants, { userId: id });
              set({ grants });
            }}
            allowedEmails={people.filter((g) => !g.userId && g.email).map((g) => g.email as string)}
            onEmailsChange={(emails) => {
              let grants = draft.grants.filter((g) => g.userId || emails.includes(g.email ?? ""));
              for (const email of emails) grants = addGrant(grants, { email });
              set({ grants });
            }}
            loading={props.membersLoading}
            currentUserId={draft.publisherUserId}
          />
        ) : null}
        <AccessRow label={`${nameOf(draft.publisherUserId)} (publisher)`}>
          <span className="ss6-role ss6-role--fixed">Admin</span>
        </AccessRow>
        {people.map((g) => (
          <AccessRow key={grantKey(g)} label={g.userId ? nameOf(g.userId) : (g.email ?? "")}>
            {select("person", g.role, (r) => set({ grants: setGrantRole(draft.grants, grantKey(g), r) }))}
            {edit ? (
              <button
                type="button"
                className="ss6-icon-btn"
                aria-label="Remove"
                onClick={() => set({ grants: removeGrant(draft.grants, grantKey(g)) })}
              >
                ×
              </button>
            ) : null}
          </AccessRow>
        ))}
      </div>

      {isLinkVisibility(draft.visibility) ? (
        <AccessRow label="Anyone with the link">
          {select("link", draft.linkRole, (r) => set({ linkRole: r }))}
        </AccessRow>
      ) : null}
      {draft.visibility === "public_read" ? (
        <AccessRow label="Community">
          {select("community", draft.communityRole, (r) => set({ communityRole: r }))}
        </AccessRow>
      ) : null}

      {draft.uploadMaxMb !== undefined ? (
        <AccessRow label="Largest upload" sub="Per file, from people using the app. Counts toward your storage.">
          <select
            className="ss6-role"
            aria-label="Largest upload"
            value={draft.uploadMaxMb}
            disabled={!edit}
            onChange={(e) => set({ uploadMaxMb: Number(e.target.value) })}
          >
            {[...new Set([...UPLOAD_MAX_MB_CHOICES, draft.uploadMaxMb])].sort((a, b) => a - b).map((mb) => (
              <option key={mb} value={mb}>{mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}</option>
            ))}
          </select>
        </AccessRow>
      ) : null}

      <label className="ss6-access-check">
        <input
          type="checkbox"
          checked={draft.approvalRule === "everyone"}
          disabled={!edit}
          onChange={(e) => set({ approvalRule: e.target.checked ? "everyone" : "contributors" })}
        />
        <span>
          <b>Require review for every change</b>
          <em>Maintainers and Admins too</em>
        </span>
      </label>

      {draft.derived && !dirty ? (
        <p className="ss6-note">Worked out from your current sharing. Nothing changes until you save.</p>
      ) : null}
      {error ? <p className="ss6-note ss6-note--warn">{error}</p> : null}

      <div className="ss6-foot">
        <button type="button" className="ss6-btn" onClick={dirty ? () => setDraft(live) : props.onClose}>
          {dirty ? "Cancel" : "Back"}
        </button>
        {dirty ? <span className="ss6-hint">Not saved yet</span> : null}
        {draft.canManage ? (
          <button
            type="button"
            className="ss6-btn ss6-btn--primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
