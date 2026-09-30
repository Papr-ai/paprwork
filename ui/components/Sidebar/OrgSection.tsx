/**
 * OrgSection — account-card org block.
 * "Org logo": admins tap the tile to upload, or point it at the website; members just see it.
 * "Switch org": every org you belong to, each with its own logo; tap to switch.
 */
import { useEffect, useRef, useState } from "react";
import { OrgMark } from "./OrgMark";
import { cleanSite, isOrgAdmin, orgLogoSrc, readLogoFile, useOrgLogos } from "./orgLogoStore";
import type { OrgEntry } from "./useOrgList";

interface OrgSectionProps {
  orgs: OrgEntry[];
  activeId: string;
  switching: boolean;
  onSwitch: (id: string) => void;
  siteFor: (org: OrgEntry) => string;
}

function LogoRow({ org, site }: { org: OrgEntry; site: string }) {
  const branding = useOrgLogos((s) => s.branding[org.id]);
  const update = useOrgLogos((s) => s.update);
  const [draft, setDraft] = useState(site);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(site), [site]);
  const src = orgLogoSrc(branding, site);

  if (!isOrgAdmin(org.role)) {
    return (
      <div className="rail-orglogo">
        <OrgMark name={org.name} src={src} className="org-mark--lg" />
        <span className="rail-orglogo__field">
          <b>{site || org.name}</b>
          <small>Only admins can change the logo.</small>
        </span>
      </div>
    );
  }

  const commit = () => {
    const next = cleanSite(draft);
    if (next !== site) update(org.id, { site: next });
    setDraft(next);
  };
  const hint = branding?.logo ? null : site ? "From your website. Tap the logo to upload your own." : "Add your website, or tap to upload.";

  return (
    <div className="rail-orglogo">
      <button type="button" className="rail-orglogo__pick" onClick={() => fileRef.current?.click()} aria-label={`Change ${org.name} logo`}>
        <OrgMark name={org.name} src={src} className="org-mark--lg" />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        data-testid="org-logo-file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) update(org.id, { logo: await readLogoFile(file) });
        }}
      />
      <span className="rail-orglogo__field">
        <input
          value={draft}
          placeholder="yourcompany.com"
          spellCheck={false}
          autoComplete="off"
          aria-label="Org website"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        <small>
          {hint ?? (
            <>
              Your upload ·{" "}
              <button type="button" onClick={() => update(org.id, { logo: undefined })}>
                Use website logo
              </button>
            </>
          )}
        </small>
      </span>
    </div>
  );
}

export function OrgSection({ orgs, activeId, switching, onSwitch, siteFor }: OrgSectionProps) {
  const branding = useOrgLogos((s) => s.branding);
  const active = orgs.find((o) => o.id === activeId);
  if (!active) return null;

  return (
    <>
      <h6>Org logo</h6>
      <LogoRow org={active} site={siteFor(active)} />

      {orgs.length > 1 ? (
        <>
          <h6>Switch org</h6>
          <div className="rail-orgs">
            {orgs.map((org) => {
              const on = org.id === activeId;
              const sub = org.organizationName && org.organizationName !== org.name ? org.organizationName : "";
              return (
                <button
                  key={org.id}
                  type="button"
                  className={`rail-org${on ? " is-active" : ""}`}
                  disabled={on || switching}
                  title={on ? "Current org" : `Switch to ${org.name}`}
                  onClick={() => onSwitch(org.id)}
                >
                  <OrgMark name={org.name} src={orgLogoSrc(branding[org.id], siteFor(org))} />
                  <span className="rail-org__name">
                    <b>{org.name}</b>
                    {sub ? <small> · {sub}</small> : null}
                  </span>
                  {on ? (
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
