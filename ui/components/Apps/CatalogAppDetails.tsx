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
import { mediaForScheme, useColorScheme } from "../../utils/catalogScheme";
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

export function CatalogBanner({ entry, coverUrl, autoPlay = false }: { entry: CommunityCatalogEntry; coverUrl: string | null; glyphSize?: number; autoPlay?: boolean }) {
  const [failed, setFailed] = useState(false);
  // Owner-shared preview video lives next to the cover (papr-cover-video); 404 → the picture.
  const [noVideo, setNoVideo] = useState(false);
  const videoUrl = catalogCoverVideoUrl(entry, coverUrl, useColorScheme());
  return (
    <span className="cat-banner">
      {videoUrl && coverUrl && !noVideo && !failed ? (
        <DemoVideo className="cat-banner__img" src={videoUrl} poster={coverUrl} autoPlay={autoPlay} onError={() => setNoVideo(true)} />
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
  /** Owner only: open the app on App info to edit this page (headline, gallery). */
  onEditPage?: () => void;
}

/** The surface the page covers: the visible Apps body (keeps the Apps top bar), else the window. */
function pageHost(): HTMLElement {
  const hosts = Array.from(document.querySelectorAll<HTMLElement>(".apps-view__body"));
  return hosts.find((v) => v.offsetParent !== null && v.getClientRects().length > 0) ?? document.body;
}

const mention = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "");

/**
 * Prototyper app page, full view (not a popup): back link, the film, identity + Get, a facts
 * strip, How it works (the gallery screens and their captions), what it can touch, where to
 * use it. Key names and the long description wait behind "More about".
 */
export function CatalogAppDetails({ entry, coverUrl, hasWeb, actions, onClose, onEditPage }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();
  const [host] = useState(pageHost);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    scroller.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const keys = catalogKeyNames(entry);
  const services = catalogKeyServices(entry);
  const updated = formatCatalogUpdated(entry.updatedAt);
  const installs = entry.installCount;
  const teamData = isTeamSharedVisibility(entry.visibility);
  const steps = mediaForScheme(entry.media, scheme).filter((m) => m.role === "gallery" && m.kind === "image" && m.url).slice(0, 3);
  const headline = entry.headline?.trim() || entry.description;
  const facts: Array<[string, string]> = [
    ...(typeof installs === "number" && installs > 0 ? [[installs.toLocaleString(), installs === 1 ? "install" : "installs"] as [string, string]] : []),
    [entry.isOwned ? "You" : (getCatalogByline(entry).replace(/^By\s+/i, "") || "Papr"), "built by"],
    [keys.length ? String(keys.length) : "None", keys.length === 1 ? "key needed" : "keys needed"],
    ...(updated ? [[updated, "updated"] as [string, string]] : []),
  ];
  const touches: Array<[string, string]> = [
    ["Uses", services.length ? services.join(", ") : "Nothing outside Papr"],
    ["Data", teamData ? "Your team's data" : "Your own private copy"],
    ["Runs", entry.catalogAutomation?.cardLine ?? "Only when you open it"],
    ["Updates", "Arrive automatically"],
  ];
  return createPortal(
    <div
      ref={scroller}
      className={`cat-page${host === document.body ? " cat-page--window" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={entry.name}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="cat-page__in">
        <button type="button" className="cat-page__back" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          {teamData ? "Team" : "Discover"}
        </button>
        <section className="cat-page__hero">
          <div className="cat-page__media"><CatalogBanner entry={entry} coverUrl={coverUrl} autoPlay /></div>
          <div className="cat-page__id">
            <DropGlyph icon={entry.icon} title={entry.name} size={88} />
            <div className="cat-page__t">
              <h1>{entry.name}</h1>
              {headline ? <p>{headline}</p> : null}
            </div>
            <div className="cat-page__cta">
              {actions}
              {onEditPage ? <button type="button" className="cat-page__edit" onClick={onEditPage}>Edit page</button> : null}
            </div>
          </div>
        </section>
        <ul className="cat-page__facts">
          {facts.map(([v, k]) => <li key={k}><b title={v}>{v}</b><span>{k}</span></li>)}
        </ul>
        {steps.length ? (
          <section className="cat-page__sec">
            <h2>How it works</h2>
            <div className="cat-page__steps">
              {steps.map((m, i) => (
                <figure key={i}>
                  <img src={viaDesktopMedia(m.url!)} alt="" loading="lazy" draggable={false} />
                  {m.alt ? <figcaption><b>{i + 1}</b>{m.alt}</figcaption> : null}
                </figure>
              ))}
            </div>
          </section>
        ) : onEditPage ? (
          <section className="cat-page__sec">
            <h2>How it works</h2>
            <button type="button" className="cat-page__empty" onClick={onEditPage}>
              <b>Show people how it works</b>
              <span>Add a short video and three screens with one line each. Papr can make them for you.</span>
            </button>
          </section>
        ) : null}
        <section className="cat-page__sec cat-page__two">
          <div>
            <h2>What it can touch</h2>
            <ul className="cat-page__rows">{touches.map(([v, w]) => <li key={v}><b>{v}</b><span>{w}</span></li>)}</ul>
          </div>
          <div>
            <h2>Use it from anywhere</h2>
            <ul className="cat-page__rows cat-page__any">
              <li><kbd>⌘K</kbd><span>Type “{entry.name.split(/\s+/)[0]?.toLowerCase()}” to open it</span></li>
              <li><kbd>@</kbd><span>Mention <b>@{mention(entry.name)}</b> in any chat</span></li>
              {hasWeb ? <li><kbd><CatIcon name="globe" size={12} /></kbd><span>Open it on the web</span></li> : null}
            </ul>
          </div>
        </section>
        <details className="cat-page__more">
          <summary>More about {entry.name}</summary>
          {entry.description && entry.description !== headline ? <p>{entry.description}</p> : null}
          <ul className="cat-page__list">
            {keys.length ? keys.map((k) => (
              <li key={k}><CatIcon name="key" /><code>{k}</code></li>
            )) : <li><CatIcon name="check" /><span>No keys needed</span></li>}
            {updated ? <li><CatIcon name="check" /><span>Updated {updated}</span></li> : null}
          </ul>
        </details>
      </div>
    </div>,
    host,
  );
}
