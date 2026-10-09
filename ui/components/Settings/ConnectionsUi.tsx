/**
 * Shared building blocks for Connections (Services, Website logins, API keys):
 * the centered detail modal, status pills, and the "Who can use it" rows.
 * Styles + light/dark tokens live in ConnectionsUi.css.
 */

import { useEffect, type ReactNode } from "react";
import "./ConnectionsUi.css";

export function Sheet({
  label,
  mark,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  label: string;
  mark: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cx-scrim" onClick={onClose}>
      <aside className="cx-sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <header className="cx-sheet__head">
          {mark}
          <div className="cx-sheet__ttl">
            <h3>{title}</h3>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <button type="button" className="cx-x" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="cx-sheet__body">{children}</div>
        {footer && <footer className="cx-sheet__foot">{footer}</footer>}
      </aside>
    </div>
  );
}

export type PillTone = "ok" | "wait" | "warn" | "team" | "plain";

export function Pills({ items }: { items: Array<[PillTone, string] | false | null | undefined> }) {
  const shown = items.filter(Boolean) as Array<[PillTone, string]>;
  if (!shown.length) return null;
  return (
    <div className="cx-pills">
      {shown.map(([tone, text]) => (
        <span key={text} className={`cx-pill cx-pill--${tone}`}>
          {text}
        </span>
      ))}
    </div>
  );
}

/** One "Who can use it" card; children are AccessRow / extra content. */
export function AccessCard({ children }: { children: ReactNode }) {
  return <div className="cx-acc">{children}</div>;
}

export function AccessRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="cx-arow">
      <div className="cx-alab">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function AccessSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="cx-asel"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Fixed({ children }: { children: ReactNode }) {
  return <span className="cx-aval">{children}</span>;
}

export function Fine({ children }: { children: ReactNode }) {
  return (
    <p className="cx-fine">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      {children}
    </p>
  );
}

export function Note({ title, children, tone = "info" }: { title: string; children?: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div className={`cx-note cx-note--${tone}`}>
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  kind,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  kind?: "primary" | "danger" | "cta";
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" className={`cx-btn${kind ? ` cx-btn--${kind}` : ""}`} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export function KeyMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`svc-logo svc-logo--${size} cx-kmark`} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2" />
      </svg>
    </span>
  );
}

export function GlobeMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`svc-logo svc-logo--${size} cx-kmark`} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    </span>
  );
}
