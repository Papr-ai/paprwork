/**
 * Role picker for the Share sheet: the button shows just the role; the menu
 * shows each role with a one-line meaning, a check on the current one, and
 * "Remove access" at the bottom (no × buttons on rows).
 */

import { useEffect, useRef, useState } from "react";
import { ROLE_COPY, type AppRole } from "../../utils/appRolesModel";

export interface ShareRoleMenuProps {
  value: AppRole;
  options: AppRole[];
  label: string;
  onChange: (r: AppRole) => void;
  /** Omit to hide "Remove access" (e.g. nothing to remove). */
  onRemove?: () => void;
  readOnly?: boolean;
}

export function ShareRoleMenu({ value, options, label, onChange, onRemove, readOnly }: ShareRoleMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (readOnly) return <span className="ss9-role">{ROLE_COPY[value].label}</span>;
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <span className="ss9-dd" ref={ref}>
      <button type="button" className={`ss9-ddbtn${open ? " ss9-ddbtn--open" : ""}`} aria-haspopup="menu"
        aria-expanded={open} aria-label={`${label} role`} onClick={() => setOpen((o) => !o)}>
        {ROLE_COPY[value].label}
      </button>
      {open ? (
        <div className="ss9-menu" role="menu">
          {options.map((r) => (
            <button key={r} type="button" role="menuitemradio" aria-checked={r === value} className="ss9-mi"
              onClick={pick(() => onChange(r))}>
              <span className="ss9-mi-t"><b>{ROLE_COPY[r].label}</b><small>{ROLE_COPY[r].sub}</small></span>
              <span className="ss9-mi-ck" aria-hidden>{r === value ? "✓" : ""}</span>
            </button>
          ))}
          {onRemove ? (
            <>
              <div className="ss9-mi-sep" />
              <button type="button" role="menuitem" className="ss9-mi ss9-mi--rm" onClick={pick(onRemove)}>
                <b>Remove access</b>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
