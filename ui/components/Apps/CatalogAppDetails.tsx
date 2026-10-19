/**
 * Team / Community app details — a full app page opened from a catalog card.
 * One Get button (resolveOneInstallSelection decides track vs fork and data);
 * no "Use it / Make my own copy" choice.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DemoVideo } from "./DemoVideo";
import { createPortal } from "react-dom";
import type { CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import { isTeamSharedVisibility } from "../../../src/core/types/communityCatalog";
import { normalizeRequirements } from "../../../src/core/types/bundles";
import { lookupService } from "../../../src/core/data/knownServices";
import { formatCatalogUpdated, getCatalogByline } from "../../utils/communityCatalogDisplay";
import { DropGlyph } from "./HomeTiles";
import { DefaultCover } from "./DefaultCover";
import { catalogCoverVideoUrl, viaDesktopMedia } from "../../utils/catalogPreviewUrl";
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

export function CatalogBanner({ entry, coverUrl }: { entry: CommunityCatalogEntry; coverUrl: string | null; glyphSize?: number }) {
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
        // No approved gallery: the default Papr-blue cover with the app's name.
        <DefaultCover name={entry.name} />
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

/**
 * Prototyper-style app page in a centered modal: the whole preview film (inset in its own
 * rounded frame, so nothing dark touches the card's corners), identity row with a big Get,
 * a facts strip, screenshots, then what it needs / runs. Scrolls inside; Esc/backdrop closes.
 */
export function CatalogAppDetails({ entry, coverUrl, hasWeb, actions, onClose }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    scroller.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const keys = catalogKeyNames(entry);
  const updated = formatCatalogUpdated(entry.updatedAt);
  const installs = entry.installCount;
  const teamData = isTeamSharedVisibility(entry.visibility);
  const shots = (entry.media ?? []).filter((m) => m.role === "gallery" && m.kind === "image" && m.url);
  const facts: Array<[string, string]> = [
    ...(typeof installs === "number" && installs > 0 ? [[installs.toLocaleString(), installs === 1 ? "install" : "installs"] as [string, string]] : []),
    [entry.isOwned ? "You" : (getCatalogByline(entry).replace(/^By\s+/i, "") || "Papr"), "built by"],
    [String(keys.length), keys.length === 1 ? "key needed" : "keys needed"],
    ...(updated ? [[updated, "updated"] as [string, string]] : []),
    ...(hasWeb ? [["Web", "also runs on"] as [string, string]] : []),
  ];
  return createPortal(
    <div
      className="cat-modal"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="cat-modal__card" role="dialog" aria-modal="true" aria-label={entry.name}>
      <button type="button" className="cat-modal__x" onClick={onClose} aria-label="Close"><CatIcon name="x" size={14} /></button>
      <div ref={scroller} className="cat-modal__scroll cat-page__in" tabIndex={-1}>
        <section className="cat-page__hero">
          <div className="cat-page__media"><CatalogBanner entry={entry} coverUrl={coverUrl} /></div>
          <div className="cat-page__id">
            <DropGlyph icon={entry.icon} title={entry.name} size={88} />
            <div className="cat-page__t">
              <h1>{entry.name}</h1>
              {entry.headline?.trim() ? <p>{entry.headline.trim()}</p> : null}
            </div>
            <div className="cat-page__cta">{actions}</div>
          </div>
        </section>
        <ul className="cat-page__facts">
          {facts.map(([v, k]) => <li key={k}><b title={v}>{v}</b><span>{k}</span></li>)}
        </ul>
        {entry.description ? (
          <section className="cat-page__sec"><h2>About</h2><p className="cat-page__desc">{entry.description}</p></section>
        ) : null}
        {shots.length ? (
          <section className="cat-page__sec">
            <h2>Screenshots</h2>
            <div className="cat-page__shots">
              {shots.map((m, i) => (
                <figure key={i}>
                  <img src={viaDesktopMedia(m.url!)} alt={m.alt ?? ""} loading="lazy" draggable={false} />
                  {m.alt ? <figcaption>{m.alt}</figcaption> : null}
                </figure>
              ))}
            </div>
          </section>
        ) : null}
        <section className="cat-page__sec cat-page__two">
          <div>
            <h2>What it needs</h2>
            <ul className="cat-page__list">
              {keys.length ? keys.map((k) => (
                <li key={k}><CatIcon name="key" /><code>{k}</code></li>
              )) : <li><CatIcon name="check" /><span>No keys needed</span></li>}
            </ul>
          </div>
          <div>
            <h2>What it runs</h2>
            <ul className="cat-page__list">
              <li><CatIcon name="bolt" /><span>{entry.catalogAutomation?.cardLine ?? "Nothing in the background"}</span></li>
              {hasWeb ? <li><CatIcon name="globe" /><span>Also works on the web</span></li> : null}
            </ul>
          </div>
        </section>
        {!entry.isOwned ? (
          <p className="cat-page__note">
            {teamData ? "Uses your team's data." : "Your data stays private."} Updates arrive automatically.
          </p>
        ) : null}
      </div>
      </div>
    </div>,
    document.body,
  );
}
