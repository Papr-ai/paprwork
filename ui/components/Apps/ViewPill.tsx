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

const ICONS: Record<PillView | "settings", ReactNode> = {
  live: <path d="M2 8a6 6 0 1 0 12 0A6 6 0 0 0 2 8Zm6-3v3l2 2" />,
  preview: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  settings: <path d="M3 4.5h10M3 8h10M3 11.5h10M6 3v3M10 6.5v3M5 10v3" />,
};

function Icon({ name }: { name: PillView | "settings" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
  onSettings: (target: "jobs" | "code" | "data" | null) => void;
}

export function ViewPill({ model, active, settingsOpen, onView, onVerb, onSettings }: ViewPillProps) {
  const viewBtn = (v: PillView) => {
    const st = model[v];
    const on = v === active;
    const cls = `vp__btn${on ? " is-on" : ""}${v === "preview" ? " vp__btn--preview" : ""}`;
    if (!on) {
      const d = viewDot(v, st);
      return (
        <button key={v} type="button" className={cls} title={`${LABEL[v]} · ${st.label}`}
          aria-label={d ? `${LABEL[v]}, ${st.label}` : LABEL[v]} aria-pressed={false}
          onClick={() => onView(v)}>
          <Icon name={v} />
          <Dot tone={d} />
        </button>
      );
    }
    return (
      <span key={v} className={cls} title={TIP[v]} aria-pressed>
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
        title={settingsOpen ? "Close Settings" : sd ? `Settings, ${sd.label}` : "Settings: code, data, jobs"}
        aria-label={sd ? `Settings, ${sd.label}` : "Settings"} aria-pressed={settingsOpen}
        onClick={() => onSettings(settingsOpen ? null : sd?.target ?? "data")}>
        <Icon name="settings" />
        {settingsOpen ? <span>Settings</span> : <Dot tone={sd?.tone ?? null} />}
      </button>
    </div>
  );
}
