/**
 * Share sheet v6 — "Share is three questions".
 *
 * Draft app: who → what → keys as three short steps, ending in one Publish.
 * Live app: the link first (the thing people open Share for), then the three
 * answers as rows. Clicking a row opens that step; every click saves at once.
 * Publishing code stays on the bar — this sheet never says "Update web".
 *
 * Reference: Share Bar Redesign prototype, v6.
 */

import React, { useEffect, useState } from "react";
import type { RequiredKeySpec } from "../../../src/core/types/bundles";
import type { ShareAudience } from "../../utils/shareAudienceModel";
import { shareAudienceGlyphPath } from "../../utils/shareAudienceGlyphs";
import { fetchAppRequirements } from "../../utils/cloudAppRequirementsApi";
import {
  SHARE_AUDIENCE_COPY,
  SHARE_AUDIENCE_ORDER,
  SHARE_STEP_TITLE,
  perUserDataAvailable,
  shareSteps,
  signInIsOptional,
  summarizeKeys,
  summarizeWhat,
  type ShareStepId,
  type SharingDraft,
  type SharingPatch,
} from "../../utils/shareSheetModel";
import { CloudAppCredentialsPanel } from "./CloudAppCredentialsPanel";
import "./ShareSheetBody.css";

export interface ShareSheetBodyProps {
  appId: string;
  appTitle: string;
  live: boolean;
  draft: SharingDraft;
  onChange: (patch: SharingPatch) => void;
  /** Rendered under "Specific people" when it is selected. */
  peoplePicker: React.ReactNode;
  /** Live link; null until published. */
  linkUrl: string | null;
  /** Caveat under the link (upload still running, token pending). */
  linkHint?: string | null;
  onCopyLink: () => void;
  onOpenLink: () => void;
  busy: boolean;
  /** Blocks the change that would widen "Specific people" to the whole workspace. */
  peopleAllowlistEmpty: boolean;
  publishLabel: string;
  publishDisabled: boolean;
  onPublish: () => void;
  /** Status / errors / dependency panels, rendered above the steps. */
  notices?: React.ReactNode;
  /** Optional deep link into one step (e.g. a missing-key chip). */
  initialEdit?: ShareStepId | null;
}

const ICON_PATHS = {
  what: "M2.5 8.5 7 4l4.5 4.5M7 4v9.5M11 13.5h3",
  keys: "M10 2.5a3.5 3.5 0 1 1-2.9 5.5L2.5 12.6v1.9h2v-1.5h1.5V11.5h1.5l.9-.9A3.5 3.5 0 0 1 10 2.5Zm1 2.6h.01",
  copy: "M5.5 5.5V3.2c0-.4.3-.7.7-.7h6.6c.4 0 .7.3.7.7v6.6c0 .4-.3.7-.7.7h-2.3M3.2 5.5h6.6c.4 0 .7.3.7.7v6.6c0 .4-.3.7-.7.7H3.2a.7.7 0 0 1-.7-.7V6.2c0-.4.3-.7.7-.7Z",
  open: "M10.5 2.5h3v3M8.5 7.5 13 3M6.5 3h-3a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H12a1 1 0 0 0 1-1v-3",
  chevron: "m6 3.5 4.5 4.5L6 12.5",
  code: "M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5",
};

function Glyph({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const AudienceGlyph = ({ audience }: { audience: ShareAudience }) => (
  <Glyph d={shareAudienceGlyphPath(audience)} />
);

function CodeMark() {
  return (
    <span className="ss6-code" aria-label="includes code">
      <Glyph d={ICON_PATHS.code} size={11} />
    </span>
  );
}

function Option({
  on,
  label,
  sub,
  icon,
  disabled,
  onPick,
}: {
  on: boolean;
  label: React.ReactNode;
  sub: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={`ss6-opt${on ? " ss6-opt--on" : ""}`}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="ss6-radio" aria-hidden />
      {icon ? <span className="ss6-opt-ico">{icon}</span> : null}
      <span className="ss6-opt-text">
        <b>{label}</b>
        <em>{sub}</em>
      </span>
    </button>
  );
}

function Toggle({
  on,
  label,
  sub,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  sub: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`ss6-tog${on ? " ss6-tog--on" : ""}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="ss6-opt-text">
        <b>{label}</b>
        <em>{sub}</em>
      </span>
      <span className="ss6-switch" aria-hidden>
        <i />
      </span>
    </button>
  );
}

const PROPOSALS_NOTE =
  "They can propose changes; you review before anything merges.";

function WhoStep({ props }: { props: ShareSheetBodyProps }) {
  const { draft, onChange, busy, peoplePicker } = props;
  return (
    <div role="radiogroup" aria-label={SHARE_STEP_TITLE.who}>
      <h6 className="ss6-h">{SHARE_STEP_TITLE.who}</h6>
      {SHARE_AUDIENCE_ORDER.map((audience) => (
        <React.Fragment key={audience}>
          <Option
            on={draft.audience === audience}
            label={SHARE_AUDIENCE_COPY[audience].label}
            sub={SHARE_AUDIENCE_COPY[audience].sub}
            icon={<AudienceGlyph audience={audience} />}
            disabled={busy}
            onPick={() => onChange({ audience })}
          />
          {audience === "people" && draft.audience === "people" ? (
            <div className="ss6-people">{peoplePicker}</div>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

function WhatStep({ props }: { props: ShareSheetBodyProps }) {
  const { draft, onChange, busy } = props;
  const useOnly = draft.permission !== "edit";
  const perUserOk = perUserDataAvailable(draft);
  return (
    <div role="radiogroup" aria-label={SHARE_STEP_TITLE.what}>
      <h6 className="ss6-h">{SHARE_STEP_TITLE.what}</h6>
      <Option
        on={useOnly}
        label="Use your app"
        sub="They open your live app and its data."
        disabled={busy}
        onPick={() => onChange({ permission: "write" })}
      />
      {useOnly ? (
        <div className="ss6-sub">
          {signInIsOptional(draft.audience) ? (
            <Toggle
              on={draft.requireSignIn}
              label="Require Papr sign-in"
              sub="Know who's using it."
              disabled={busy}
              onToggle={() => onChange({ requireSignIn: !draft.requireSignIn })}
            />
          ) : null}
          <Toggle
            on={perUserOk && draft.perUserIsolation}
            label="Give each person their own data"
            sub={
              perUserOk
                ? "Each signed-in person gets a private database."
                : "Needs sign-in, so visitors can be told apart."
            }
            disabled={busy || !perUserOk}
            onToggle={() =>
              onChange({ perUserIsolation: !draft.perUserIsolation })
            }
          />
        </div>
      ) : null}
      <Option
        on={!useOnly}
        label={
          <>
            {draft.audience === "public"
              ? "Install their own copy"
              : "Use it or install a copy"}
            <CodeMark />
          </>
        }
        sub={
          draft.audience === "public"
            ? "Installs into their Papr with empty data. Stays linked to yours for updates."
            : "Their copy stays linked to yours for updates."
        }
        disabled={busy}
        onPick={() => onChange({ permission: "edit" })}
      />
      {!useOnly ? <p className="ss6-note">{PROPOSALS_NOTE}</p> : null}
    </div>
  );
}

function KeysStep({
  props,
  onSaved,
}: {
  props: ShareSheetBodyProps;
  onSaved: () => void;
}) {
  return (
    <div>
      <h6 className="ss6-h">Whose API keys it runs on</h6>
      <CloudAppCredentialsPanel
        appId={props.appId}
        appTitle={props.appTitle}
        busy={props.busy}
        appLive={props.live}
        onSaved={onSaved}
      />
    </div>
  );
}

function StepView({
  id,
  props,
  onKeysSaved,
}: {
  id: ShareStepId;
  props: ShareSheetBodyProps;
  onKeysSaved: () => void;
}) {
  if (id === "who") return <WhoStep props={props} />;
  if (id === "what") return <WhatStep props={props} />;
  return <KeysStep props={props} onSaved={onKeysSaved} />;
}

function LinkHero({ props }: { props: ShareSheetBodyProps }) {
  const { draft, linkUrl, linkHint } = props;
  if (draft.audience === "private") {
    return (
      <div className="ss6-hero ss6-hero--muted">
        <span className="ss6-hero-ico">
          <AudienceGlyph audience="private" />
        </span>
        <span className="ss6-hero-txt">
          <b>Only you can open it</b>
          <small>Change who below to get a link.</small>
        </span>
      </div>
    );
  }
  return (
    <div className="ss6-hero">
      <span className="ss6-hero-ico">
        <AudienceGlyph audience={draft.audience} />
      </span>
      <span className="ss6-hero-txt">
        <b title={linkUrl ?? ""}>{linkUrl ?? "Link appears after publish"}</b>
        <small>{linkHint || SHARE_AUDIENCE_COPY[draft.audience].sub}</small>
      </span>
      {linkUrl ? (
        <span className="ss6-hero-actions">
          <button
            type="button"
            className="ss6-icon-btn"
            title="Open in browser"
            aria-label="Open in browser"
            onClick={props.onOpenLink}
          >
            <Glyph d={ICON_PATHS.open} />
          </button>
          <button
            type="button"
            className="ss6-btn ss6-btn--primary"
            onClick={props.onCopyLink}
          >
            <Glyph d={ICON_PATHS.copy} />
            Copy link
          </button>
        </span>
      ) : null}
    </div>
  );
}

function useKeySpecs(
  appId: string,
  reloadToken: number,
): RequiredKeySpec[] | null {
  const [specs, setSpecs] = useState<RequiredKeySpec[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAppRequirements(appId)
      .then((d) => !cancelled && setSpecs(d.requirements))
      .catch(() => !cancelled && setSpecs([]));
    return () => {
      cancelled = true;
    };
  }, [appId, reloadToken]);
  return specs;
}

function LiveSummary({
  props,
  keySpecs,
  onEdit,
}: {
  props: ShareSheetBodyProps;
  keySpecs: RequiredKeySpec[] | null;
  onEdit: (id: ShareStepId) => void;
}) {
  const { draft } = props;
  const rows: { id: ShareStepId; value: string; icon: React.ReactNode }[] = [
    {
      id: "who",
      value: SHARE_AUDIENCE_COPY[draft.audience].label,
      icon: <AudienceGlyph audience={draft.audience} />,
    },
  ];
  if (draft.audience !== "private") {
    rows.push({
      id: "what",
      value: summarizeWhat(draft),
      icon: <Glyph d={ICON_PATHS.what} />,
    });
    rows.push({
      id: "keys",
      value: summarizeKeys(keySpecs),
      icon: <Glyph d={ICON_PATHS.keys} />,
    });
  }
  return (
    <>
      <LinkHero props={props} />
      <div className="ss6-summary">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className="ss6-arow"
            onClick={() => onEdit(row.id)}
          >
            <span className="ss6-tico">{row.icon}</span>
            <span className="ss6-row-v">
              <small>{SHARE_STEP_TITLE[row.id]}</small>
              <b>{row.value}</b>
            </span>
            <span className="ss6-change">
              Change
              <Glyph d={ICON_PATHS.chevron} size={12} />
            </span>
          </button>
        ))}
      </div>
      <p className="ss6-note">
        Code edits reach them when you Publish from the bar.
      </p>
    </>
  );
}

export function ShareSheetBody(props: ShareSheetBodyProps) {
  const { draft, live, busy, notices } = props;
  const [edit, setEdit] = useState<ShareStepId | null>(
    props.initialEdit ?? null,
  );
  const [step, setStep] = useState(0);
  const [keysReload, setKeysReload] = useState(0);
  const keySpecs = useKeySpecs(props.appId, keysReload);
  const onKeysSaved = () => setKeysReload((n) => n + 1);

  const steps = shareSteps(draft.audience);
  const stepIndex = Math.min(step, steps.length - 1);

  if (live) {
    return (
      <div className="ss6">
        {notices}
        {edit ? (
          <>
            <StepView id={edit} props={props} onKeysSaved={onKeysSaved} />
            {edit === "who" && props.peopleAllowlistEmpty ? (
              <p className="ss6-note ss6-note--warn">
                Add at least one person, email or domain. Until then the current
                access stays.
              </p>
            ) : null}
            <div className="ss6-foot">
              <button
                type="button"
                className="ss6-btn"
                onClick={() => setEdit(null)}
              >
                Back
              </button>
              <span className="ss6-hint">Changes apply right away</span>
            </div>
          </>
        ) : (
          <LiveSummary props={props} keySpecs={keySpecs} onEdit={setEdit} />
        )}
      </div>
    );
  }

  const current = steps[stepIndex];
  const last = stepIndex === steps.length - 1;
  return (
    <div className="ss6">
      {notices}
      <p className="ss6-progress">
        {SHARE_STEP_TITLE[current]} · {stepIndex + 1} of {steps.length}
      </p>
      <StepView id={current} props={props} onKeysSaved={onKeysSaved} />
      <div className="ss6-foot">
        {stepIndex > 0 ? (
          <button
            type="button"
            className="ss6-btn"
            onClick={() => setStep(stepIndex - 1)}
          >
            Back
          </button>
        ) : (
          <span className="ss6-dots" aria-hidden>
            {steps.map((id, i) => (
              <i
                key={id}
                className={
                  i === stepIndex ? "on" : i < stepIndex ? "done" : undefined
                }
              />
            ))}
          </span>
        )}
        {last ? (
          <button
            type="button"
            className="ss6-btn ss6-btn--primary"
            disabled={
              busy || props.publishDisabled || props.peopleAllowlistEmpty
            }
            title={
              props.peopleAllowlistEmpty
                ? "Add at least one person, email or domain — or pick a different audience"
                : undefined
            }
            onClick={props.onPublish}
          >
            {busy ? "Publishing…" : props.publishLabel}
          </button>
        ) : (
          <button
            type="button"
            className="ss6-btn ss6-btn--primary"
            disabled={current === "who" && props.peopleAllowlistEmpty}
            onClick={() => setStep(stepIndex + 1)}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
