/**
 * OrgColorList — account-card org section.
 * "Org color": swatches that recolor the org you're in (always visible — that color is the ring).
 * "Switch org": every org you belong to, each shown in its own color; tap to switch.
 */
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
  if (!activeId) return null;
  const activeIndex = orgs.findIndex((o) => o.id === activeId);
  const current = orgColorFor(activeId, colors, activeIndex);

  return (
    <>
      <h6>Org color</h6>
      <div className="rail-account__swatches" role="radiogroup" aria-label="Color for the current org">
        {ORG_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === current}
            aria-label={`Org color ${c}`}
            className={`rail-account__swatch${c === current ? " is-on" : ""}`}
            style={{ "--c": c } as React.CSSProperties}
            onClick={() => setColor(activeId, c)}
          />
        ))}
      </div>

      {orgs.length > 1 ? (
        <>
          <h6>Switch org</h6>
          <div className="rail-orgs">
            {orgs.map((org, i) => {
              const active = org.id === activeId;
              const sub = org.organizationName && org.organizationName !== org.name ? org.organizationName : "";
              return (
                <button
                  key={org.id}
                  type="button"
                  className={`rail-org${active ? " is-active" : ""}`}
                  disabled={active || switching}
                  title={active ? "Current org" : `Switch to ${org.name}`}
                  onClick={() => onSwitch(org.id)}
                >
                  <i style={{ "--c": orgColorFor(org.id, colors, i) } as React.CSSProperties} aria-hidden="true" />
                  <span>
                    <b>{org.name}</b>
                    {sub ? <small> · {sub}</small> : null}
                  </span>
                  {active ? (
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </>
  );
}
