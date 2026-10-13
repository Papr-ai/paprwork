/**
 * v9 Share sheet (Share Bar Redesign prototype, v9).
 *
 * Summary: the link, then "Who has access" and "API keys" rows. Editing walks
 * Who has access → API keys (only if the app has keys) and saves once.
 * Non-Admins see Who has access read-only. Shown when the server supports
 * several audiences at once; otherwise the older sheet stays.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { saveAppAccess } from "../../utils/appAccessApi";
import type { AppAccess } from "../../utils/appRolesModel";
import {
  audiencesDirty,
  audiencesPatch,
  draftFromAccess,
  summarizeAudiences,
  widestAudience,
  type AudiencesDraft,
} from "../../utils/shareAudiencesModel";
import { shareAudienceGlyphPath } from "../../utils/shareAudienceGlyphs";
import { summarizeKeys } from "../../utils/shareSheetModel";
import { ShareDataCheck } from "./ShareDataCheck";
import { Glyph, ICON_PATHS, KeysStep, useKeySpecs, type KeysDraft, type ShareSheetBodyProps } from "./ShareSheetBody";
import { ShareWhoV9 } from "./ShareWhoV9";
import type { SharePeopleMember } from "./SharePeoplePicker";
import { useAppAccess } from "../../hooks/useAppAccess";
import { supportsAudiences } from "../../utils/shareAudiencesModel";

type Step = "who" | "keys";

export interface ShareSheetV9Props {
  body: ShareSheetBodyProps;
  access: AppAccess;
  onAccessSaved: (a: AppAccess) => void;
  /** Team copy: no link of its own, just who has access to the original. */
  hideLink?: boolean;
}

export function ShareSheetV9({ body, access, onAccessSaved, hideLink }: ShareSheetV9Props) {
  const [step, setStep] = useState<Step | null>(access.canManage ? null : "who");
  const [draft, setDraft] = useState<AudiencesDraft>(() => draftFromAccess(access));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keysReload, setKeysReload] = useState(0);
  const keySpecs = useKeySpecs(body.appId, keysReload);
  const hasKeys = !hideLink && (keySpecs?.length ?? 0) > 0;
  const [keysDirty, setKeysDirty] = useState(false);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  const keys: KeysDraft = {
    dirty: keysDirty,
    setDirty: setKeysDirty,
    saveRef,
    onSaved: () => {
      setKeysReload((n) => n + 1);
      body.onKeysSaved?.();
    },
  };
  useEffect(() => setDraft(draftFromAccess(access)), [access]);

  const live = useMemo(() => draftFromAccess(access), [access]);
  const pub = access.publisherUserId;
  const whoDirty = audiencesDirty(access, draft);
  const widest = widestAudience(step ? draft : live, pub);
  const dataCheck = (
    <ShareDataCheck appId={body.appId} audience={widest} requireSignIn={(step ? draft : live).requireSignIn}
      readOnly={!access.canManage} />
  );
  const members = body.access?.members ?? [];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (keysDirty && !(await saveRef.current?.())) return;
      if (whoDirty) onAccessSaved(await saveAppAccess(body.appId, audiencesPatch(access, draft)));
      setStep(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    setDraft(live);
    setError(null);
    setStep(null);
  };

  if (!access.canManage) {
    return (
      <div className="ss6">
        {body.notices}
        {hideLink ? null : <Hero body={body} audience={widestAudience(live, pub)} summary={summarizeAudiences(live, pub)} />}
        <ShareWhoV9 access={access} draft={live} onChange={() => undefined} members={members}
          membersLoading={body.access?.membersLoading} dataCheck={dataCheck} />
      </div>
    );
  }

  if (step) {
    const last = step === "keys" || !hasKeys;
    return (
      <div className="ss6">
        {body.notices}
        <div hidden={step !== "who"}>
          <h6 className="ss6-h">Who has access{hasKeys ? <span className="ss6-hint"> · Step 1 of 2</span> : null}</h6>
          <ShareWhoV9 access={access} draft={draft} onChange={setDraft} members={members}
            membersLoading={body.access?.membersLoading} dataCheck={dataCheck} />
        </div>
        {hasKeys ? <KeysStep props={body} keys={keys} hidden={step !== "keys"} /> : null}
        {error ? <p className="ss6-note ss6-note--warn">{error}</p> : null}
        <div className="ss6-foot">
          <button type="button" className="ss6-btn" onClick={step === "keys" ? () => setStep("who") : cancel}>
            {step === "keys" ? "Back" : whoDirty || keysDirty ? "Cancel" : "Back"}
          </button>
          {whoDirty || keysDirty ? <span className="ss6-hint">Not saved yet</span> : null}
          {last ? (
            <button type="button" className="ss6-btn ss6-btn--primary" disabled={saving || body.busy}
              onClick={() => (whoDirty || keysDirty ? void save() : setStep(null))}>
              {saving ? "Saving…" : whoDirty || keysDirty ? "Save changes" : "Done"}
            </button>
          ) : (
            <button type="button" className="ss6-btn ss6-btn--primary" onClick={() => setStep("keys")}>Next</button>
          )}
        </div>
      </div>
    );
  }

  const summary = summarizeAudiences(live, pub) || "Only you";
  return (
    <div className="ss6">
      {body.notices}
      {hideLink ? null : <Hero body={body} audience={widestAudience(live, pub)} summary={summary} />}
      <div className="ss6-summary">
        <Row label="Who has access" value={summary} icon={ICON_PATHS.roles} onClick={() => setStep("who")} />
        {hasKeys ? (
          <Row label="API keys" value={summarizeKeys(keySpecs, body.missingKeys)} icon={ICON_PATHS.keys}
            tone={body.missingKeys.length ? "warn" : undefined} onClick={() => setStep("keys")} />
        ) : null}
      </div>
      {dataCheck}
      {body.webCompatibilityHint ? <p className="ss6-note ss6-note--compat-hint">{body.webCompatibilityHint}</p> : null}
      <p className="ss6-note">Code edits reach them when you Publish from the bar.</p>
    </div>
  );
}

function Row({ label, value, icon, tone, onClick }: {
  label: string; value: string; icon: string; tone?: "warn"; onClick: () => void;
}) {
  return (
    <button type="button" className={`ss6-arow${tone ? ` ss6-arow--${tone}` : ""}`} onClick={onClick}>
      <span className="ss6-tico"><Glyph d={icon} /></span>
      <span className="ss6-row-v"><small>{label}</small><b>{value}</b></span>
      <span className="ss6-change">Change<Glyph d={ICON_PATHS.chevron} size={12} /></span>
    </button>
  );
}

function Hero({ body, audience, summary }: {
  body: ShareSheetBodyProps; audience: ReturnType<typeof widestAudience>; summary: string;
}): React.ReactElement {
  const url = audience === "private" ? null : body.linkUrl;
  return (
    <div className={`ss6-hero${url ? "" : " ss6-hero--muted"}`}>
      <span className="ss6-hero-ico"><Glyph d={shareAudienceGlyphPath(audience)} /></span>
      <span className="ss6-hero-txt">
        <b title={url ?? ""}>{audience === "private" ? "Only Admins can open it" : (url ?? "Preparing link…")}</b>
        <small>{audience === "private" ? "Turn on an audience below to share it." : body.linkHint || summary}</small>
      </span>
      {url ? (
        <span className="ss6-hero-actions">
          <button type="button" className="ss6-icon-btn" title="Open in browser" aria-label="Open in browser" onClick={body.onOpenLink}>
            <Glyph d={ICON_PATHS.open} />
          </button>
          <button type="button" className="ss6-btn ss6-btn--primary" onClick={body.onCopyLink}>
            <Glyph d={ICON_PATHS.copy} />
            Copy link
          </button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * A team copy's Share: who has access to the original (no link of its own).
 * v9 rows when the server supports audiences, else the older roles panel.
 */
export function ShareAccessSheet(props: {
  appId: string;
  members: SharePeopleMember[];
  membersLoading?: boolean;
  onClose: () => void;
  fallback: React.ReactNode;
}) {
  const { access, loading, setAccess } = useAppAccess(props.appId);
  if (loading) return <p className="ss6-note">Loading access…</p>;
  if (!supportsAudiences(access)) return <>{props.fallback}</>;
  const body = {
    appId: props.appId,
    missingKeys: [],
    busy: false,
    access: { members: props.members, membersLoading: props.membersLoading },
  } as unknown as ShareSheetBodyProps;
  return <ShareSheetV9 body={body} access={access} onAccessSaved={setAccess} hideLink />;
}
