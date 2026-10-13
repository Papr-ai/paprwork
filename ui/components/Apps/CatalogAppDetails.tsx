/**
 * Team / Community app details — centered modal opened from a catalog card.
 * One Get button (resolveOneInstallSelection decides track vs fork and data);
 * no "Use it / Make my own copy" choice.
 */
import { useEffect, useState, type ReactNode } from "react";
import { DemoVideo } from "./DemoVideo";
import { createPortal } from "react-dom";
import type { CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import { isTeamSharedVisibility } from "../../../src/core/types/communityCatalog";
import { normalizeRequirements } from "../../../src/core/types/bundles";
import { lookupService } from "../../../src/core/data/knownServices";
import { formatCatalogUpdated, getCatalogByline } from "../../utils/communityCatalogDisplay";
import { DropGlyph } from "./HomeTiles";
import { catalogCoverVideoUrl } from "../../utils/catalogPreviewUrl";
import "./CatalogAppDetails.css";

export function catalogKeyNames(entry: CommunityCatalogEntry): string[] {
  return normalizeRequirements(entry.requirements ?? []).map((r) => r.name);
}

export function catalogKeyServices(entry: CommunityCatalogEntry): string[] {
  const reqs = normalizeRequirements(entry.requirements ?? []);
  return Array.from(new Set(reqs.map((r) => {
    const svc = (r as { service?: string }).service ?? lookupService(r.name)?.service;
    if (svc) return svc;
    const head = r.name.split("_")[0] ?? r.name;
    return head.charAt(0) + head.slice(1).toLowerCase();
  })));
}

export function catalogBy(entry: CommunityCatalogEntry): string {
  return entry.isOwned ? "By you" : getCatalogByline(entry);
}

const I = {
  bolt: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" strokeLinejoin="round" />,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z" /></>,
  key: <><circle cx="5.5" cy="10.5" r="3" /><path d="M7.7 8.3 13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2" strokeLinecap="round" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />,
  x: <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />,
};
export function CatIcon({ name, size = 13 }: { name: keyof typeof I; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {I[name]}
    </svg>
  );
}

export function CatalogBanner({ entry, coverUrl, glyphSize }: { entry: CommunityCatalogEntry; coverUrl: string | null; glyphSize: number }) {
  const [failed, setFailed] = useState(false);
  // Owner-shared preview video lives next to the cover (papr-cover-video); 404 → the picture.
  const [noVideo, setNoVideo] = useState(false);
  const videoUrl = catalogCoverVideoUrl(entry, coverUrl);
  return (
    <span className="cat-banner">
      {videoUrl && coverUrl && !noVideo && !failed ? (
        <DemoVideo className="cat-banner__img" src={videoUrl} poster={coverUrl} onError={() => setNoVideo(true)} />
      ) : coverUrl && !failed ? (
        <img className="cat-banner__img" src={coverUrl} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span className="cat-banner__hero">
          <DropGlyph icon={entry.icon} title={entry.name} size={glyphSize} />
        </span>
      )}
    </span>
  );
}

interface Props {
  entry: CommunityCatalogEntry;
  coverUrl: string | null;
  hasWeb: boolean;
  actions: ReactNode;
  onClose: () => void;
}

export function CatalogAppDetails({ entry, coverUrl, hasWeb, actions, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const keys = catalogKeyNames(entry);
  const updated = formatCatalogUpdated(entry.updatedAt);
  const installs = entry.installCount;
  const meta = [
    catalogBy(entry),
    updated ? `Updated ${updated}` : null,
    typeof installs === "number" && installs > 0 ? `${installs.toLocaleString()} install${installs === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const teamData = isTeamSharedVisibility(entry.visibility);
  return createPortal(
    <div
      className="cat-modal"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="cat-modal__card" role="dialog" aria-modal="true" aria-label={entry.name}>
        <button type="button" className="cat-modal__x" onClick={onClose} aria-label="Close"><CatIcon name="x" size={14} /></button>
        <CatalogBanner entry={entry} coverUrl={coverUrl} glyphSize={104} />
        <div className="cat-modal__body">
          <div className="cat-modal__head">
            <DropGlyph icon={entry.icon} title={entry.name} size={56} />
            <div className="cat-modal__ttl"><h2>{entry.name}</h2><span>{meta}</span></div>
            <div className="cat-modal__act">{actions}</div>
          </div>
          {entry.description ? <p className="cat-modal__desc">{entry.description}</p> : null}
          <div className="cat-modal__facts">
            <section>
              <h4>What it needs</h4>
              <ul>
                {keys.length ? keys.map((k) => (
                  <li key={k}><CatIcon name="key" /><code>{k}</code></li>
                )) : <li><CatIcon name="check" /><span>No keys needed</span></li>}
              </ul>
            </section>
            <section>
              <h4>What it runs</h4>
              <ul>
                <li><CatIcon name="bolt" /><span>{entry.catalogAutomation?.cardLine ?? "Nothing in the background"}</span></li>
                {hasWeb ? <li><CatIcon name="globe" /><span>Also works on the web</span></li> : null}
              </ul>
            </section>
          </div>
          {!entry.isOwned ? (
            <p className="cat-modal__note">
              {teamData ? "Uses your team's data." : "Your data stays private."} Updates arrive automatically.
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
