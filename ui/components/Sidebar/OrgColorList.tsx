/**
 * OrgColorList — every org you belong to, each with its own color. Tap a dot to recolor
 * that org (no switch needed); tap a name to switch to it. The active org gets a check.
 */
import { useState } from "react";
import type React from "react";
import { ORG_SWATCHES, orgColorFor, useOrgColors } from "./orgColorStore";
import type { OrgEntry } from "./useOrgList";

interface OrgColorListProps {
  orgs: OrgEntry[];
  activeId: string;
  switching: boolean;
  onSwitch: (id: string) => void;
}

export function OrgColorList({ orgs, activeId, switching, onSwitch }: OrgColorListProps) {
  const colors = useOrgColors((s) => s.colors);
  const setColor = useOrgColors((s) => s.setColor);
  const [editing, setEditing] = useState<string | null>(null);
  if (!orgs.length) return null;

  return (
    <>
      <h6>Orgs</h6>
      <div className="rail-orgs">
        {orgs.map((org) => {
          const color = orgColorFor(org.id, colors);
          const active = org.id === activeId;
          const open = editing === org.id;
          return (
            <div key={org.id} className={`rail-org${active ? " is-active" : ""}`}>
              <div className="rail-org__row">
                <button
                  type="button"
                  className={`rail-org__dot${open ? " is-open" : ""}`}
                  style={{ "--c": color } as React.CSSProperties}
                  aria-label={`Change color for ${org.name}`}
                  aria-expanded={open}
                  title="Change color"
                  onClick={() => setEditing(open ? null : org.id)}
                />
                <button
                  type="button"
                  className="rail-org__name"
                  disabled={active || switching}
                  title={active ? "Current org" : `Switch to ${org.name}`}
                  onClick={() => onSwitch(org.id)}
                >
                  {org.name}
                </button>
                {active ? (
                  <svg className="rail-org__check" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </div>
              {open ? (
                <div className="rail-account__swatches" role="radiogroup" aria-label={`${org.name} color`}>
                  {ORG_SWATCHES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={c === color}
                      aria-label={`Color ${c}`}
                      className={`rail-account__swatch${c === color ? " is-on" : ""}`}
                      style={{ "--c": c } as React.CSSProperties}
                      onClick={() => setColor(org.id, c)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
