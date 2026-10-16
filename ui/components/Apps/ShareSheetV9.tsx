/**
 * v9 Share sheet (Share Bar Redesign prototype, v9).
 *
 * Summary: the link, then "Who has access" and "API keys" rows. Editing walks
 * Who has access → API keys (only if the app has keys) → Gallery (only when this
 * save newly lists the app in Community without an approved gallery) and saves once.
 * Picking Community starts the gallery in the background, so it's usually ready by
 * the Gallery step; List in Community approves it and saves.
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
import { shareDemoVideo, startDemoGeneration, useDemoStatus } from "../../utils/appDemo";
import {
  galleryApproved,
  galleryUsable,
  needsGallery,
  pendingCommunity,
  setPendingCommunity,
  shareSteps,
  type ShareV9Step,
} from "../../utils/galleryGate";
import { DemoGallery } from "./DemoGallery";

type Step = ShareV9Step;

export interface ShareSheetV9Props {
  body: ShareSheetBodyProps;
  access: AppAccess;
  onAccessSaved: (a: AppAccess) => void;
  /** Team copy: no link of its own, just who has access to the original. */
  hideLink?: boolean;
}

export function ShareSheetV9({ body, access, onAccessSaved, hideLink }: ShareSheetV9Props) {
  // The status chip reopens a Community listing that is waiting on its gallery.
  const resume = access.canManage && !hideLink && body.initialGallery ? pendingCommunity(body.appId) : null;
  const withPending = (d: AudiencesDraft): AudiencesDraft => (resume ? { ...d, link: "none", community: resume } : d);
  const [step, setStep] = useState<Step | null>(access.canManage ? (resume ? "gallery" : null) : "who");
  const [draft, setDraft] = useState<AudiencesDraft>(() => withPending(draftFromAccess(access)));
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
  useEffect(() => setDraft(withPending(draftFromAccess(access))), [access]); // eslint-disable-line react-hooks/exhaustive-deps
  const demo = useDemoStatus(body.appId);
  const gallery = access.canManage && !hideLink && needsGallery(access, draft, galleryApproved(demo));
  const steps = shareSteps(hasKeys, gallery);
  // Picked Community: start the gallery now, in the background, and remember the pick.
  useEffect(() => {
    // Switched away from Community while editing: nothing is waiting any more.
    if (!gallery && step && step !== "gallery") setPendingCommunity(body.appId, null);
    if (!gallery || !demo) return;
    setPendingCommunity(body.appId, draft.community);
    if (!demo.exists && demo.task?.state !== "running") void startDemoGeneration(body.appId).catch(() => undefined);
  }, [gallery, step, demo?.exists, demo?.task?.state, draft.community, body.appId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // List in Community: approve the gallery first (the server checks it before listing).
      if (gallery && !(await shareDemoVideo(body.appId))) throw new Error("Couldn't share the gallery.");
      if (whoDirty) onAccessSaved(await saveAppAccess(body.appId, audiencesPatch(access, draft)));
      setPendingCommunity(body.appId, null);
      setStep(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    setPendingCommunity(body.appId, null);
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
          membersLoading={body.access?.membersLoading} workspaceName={body.access?.workspaceName} dataCheck={dataCheck} />
      </div>
    );
  }

  if (step) {
    const at = steps.includes(step) ? step : steps[steps.length - 1];
    const i = steps.indexOf(at);
    const last = i === steps.length - 1;
    const of = (s: Step, tail = "") => steps.length > 1 || tail
      ? <span className="ss6-hint"> · Step {steps.indexOf(s) + 1} of {steps.length}{tail}</span> : null;
    const usable = galleryUsable(demo);
    return (
      <div className={`ss6 ${at === "gallery" ? "ss6--gallery" : ""}`}>
        {body.notices}
        <div hidden={at !== "who"}>
          <h6 className="ss6-h">Who has access{of("who")}</h6>
          <ShareWhoV9 access={access} draft={draft} onChange={setDraft} members={members}
            membersLoading={body.access?.membersLoading} workspaceName={body.access?.workspaceName} dataCheck={dataCheck} />
        </div>
        {hasKeys ? <KeysStep props={body} keys={keys} hidden={at !== "keys"} step={of("keys")} /> : null}
        {at === "gallery" ? (
          <div className="ss6-gallery">
            <h6 className="ss6-h">Gallery{of("gallery", " · Required for Community")}</h6>
            {demo ? <DemoGallery appId={body.appId} appName={body.appTitle} demo={demo}
              onMake={() => void startDemoGeneration(body.appId).catch((e: Error) => setError(e.message))} /> : null}
          </div>
        ) : null}
        {error ? <p className="ss6-note ss6-note--warn">{error}</p> : null}
        <div className="ss6-foot">
          <button type="button" className="ss6-btn" onClick={i > 0 ? () => setStep(steps[i - 1]) : cancel}>
            {i > 0 ? "Back" : whoDirty || keysDirty ? "Cancel" : "Back"}
          </button>
          {at === "gallery" && !usable ? <span className="ss6-hint">You can close this. The status chip says when it's ready.</span>
            : whoDirty || keysDirty ? <span className="ss6-hint">Not saved yet</span> : null}
          {at === "gallery" ? (
            <button type="button" className="ss6-btn ss6-btn--primary" disabled={!usable || saving || body.busy} onClick={() => void save()}>
              {saving ? "Listing…" : "List in Community"}
            </button>
          ) : last ? (
            <button type="button" className="ss6-btn ss6-btn--primary" disabled={saving || body.busy}
              onClick={() => (whoDirty || keysDirty ? void save() : setStep(null))}>
              {saving ? "Saving…" : whoDirty || keysDirty ? "Save changes" : "Done"}
            </button>
          ) : (
            <button type="button" className="ss6-btn ss6-btn--primary" onClick={() => setStep(steps[i + 1])}>Next</button>
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
      {pendingCommunity(body.appId) && !hideLink ? (
        <button type="button" className="ss6-note ss6-pending" onClick={() => { setDraft(withPendingNow(live, body.appId)); setStep("gallery"); }}>
          Listing in Community needs a gallery. <b>Continue</b>
        </button>
      ) : null}
      {dataCheck}
      {body.webCompatibilityHint ? <p className="ss6-note ss6-note--compat-hint">{body.webCompatibilityHint}</p> : null}
    </div>
  );
}

function withPendingNow(d: AudiencesDraft, appId: string): AudiencesDraft {
  const role = pendingCommunity(appId);
  return role ? { ...d, link: "none", community: role } : d;
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
