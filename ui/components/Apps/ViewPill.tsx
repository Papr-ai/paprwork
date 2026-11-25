/**
 * Share bar v2 pill: Live · status | Preview · status | Settings (plan step 7).
 * Model comes from resolveViewPill; this only draws it.
 */

import type { ReactNode } from "react";
import {
  viewDot,
  type PillDot,
  type PillStatus,
  type PillView,
  type ViewPillModel,
} from "../../utils/viewPill";
import "./ViewPill.css";

// Same geometry as the mockup (icons.ts): 24-unit viewBox, 1.7 stroke.
const ICONS: Record<PillView | "settings", ReactNode> = {
  // Live: a "recording" ring with a filled centre, not a clock.
  live: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </>
  ),
  preview: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </>
  ),
};

function Icon({ name }: { name: PillView | "settings" }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

const Dot = ({ tone }: { tone: PillDot | null }) =>
  tone ? <span className={`vp__dot vp__dot--${tone}`} aria-hidden /> : null;

const LABEL: Record<PillView, string> = { live: "Live", preview: "Preview" };
const TIP: Record<PillView, string> = {
  live: "Live: the team's version",
  preview: "Preview: your changes, before anyone else sees them",
};

interface ViewPillProps {
  model: ViewPillModel;
  active: PillView;
  settingsOpen: boolean;
  onView: (view: PillView) => void;
  onVerb: (view: PillView, status: PillStatus) => void;
  onSettings: (target: "jobs" | "code" | "data" | "settings" | null) => void;
}

export function ViewPill({ model, active, settingsOpen, onView, onVerb, onSettings }: ViewPillProps) {
  const viewBtn = (v: PillView) => {
    const st = model[v];
    const on = v === active;
    const cls = `vp__btn${on ? " is-on" : ""}${v === "preview" ? " vp__btn--preview" : ""}`;
    if (!on) {
      const d = viewDot(v, st);
      return (
        <button key={v} type="button" className={cls} title={`${LABEL[v]} · ${st.hint ?? st.label}`}
          aria-label={d ? `${LABEL[v]}, ${st.label}` : LABEL[v]} aria-pressed={false}
          onClick={() => onView(v)}>
          <Icon name={v} />
          <Dot tone={d} />
        </button>
      );
    }
    return (
      <span key={v} className={cls} title={st.hint ?? TIP[v]} aria-pressed>
        <Icon name={v} />
        <span>{LABEL[v]}</span>
        <span className={`vp__st vp__st--${st.tone}`}>
          <i aria-hidden />
          <span className="vp__stt">{st.label}</span>
        </span>
        {st.verb ? (
          <button type="button" className="vp__verb" onClick={() => onVerb(v, st)}>
            {st.verb}
          </button>
        ) : null}
      </span>
    );
  };

  const sd = settingsOpen ? null : model.settingsDot;
  return (
    <div className="vp" role="toolbar" aria-label="Views and tools">
      {viewBtn("live")}
      {viewBtn("preview")}
      <span className="vp__sep" aria-hidden />
      <button type="button" className={`vp__btn${settingsOpen ? " is-on" : ""}`}
        title={settingsOpen ? "Close Settings" : sd ? `Settings, ${sd.label}` : "Settings"}
        aria-label={sd ? `Settings, ${sd.label}` : "Settings"} aria-pressed={settingsOpen}
        onClick={() => onSettings(settingsOpen ? null : sd?.target ?? "settings")}>
        <Icon name="settings" />
        {settingsOpen ? <span>Settings</span> : <Dot tone={sd?.tone ?? null} />}
      </button>
    </div>
  );
}
