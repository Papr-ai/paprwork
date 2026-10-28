/**
 * Community "Featured" banner — App Store style: dark full-width card, a big
 * editorial headline (publisher-set `headline`, else the description), the
 * app's preview filling the card (still poster; plays only while hovered), and a glass row with the droplet, name, by-line
 * and the same Open / Preview / Get buttons as the card.
 */
import { useState, type ReactNode } from "react";
import type { CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import { DropGlyph } from "./HomeTiles";
import { catalogBy } from "./CatalogAppDetails";
import { DemoVideo } from "./DemoVideo";
import { catalogCoverVideoUrl } from "../../utils/catalogPreviewUrl";
import { useColorScheme } from "../../utils/catalogScheme";
import "./CatalogFeatured.css";

/** Publisher headline first, then most installs. Your own apps compete like any other. */
export function pickFeaturedCatalogEntry(entries: CommunityCatalogEntry[]): CommunityCatalogEntry | null {
  const pool = entries.filter((e) => e.source === "cloud" && e.codeInstallable);
  if (pool.length < 4) return null;
  const score = (e: CommunityCatalogEntry) => (e.headline?.trim() ? 1e9 : 0) + (e.installCount ?? 0);
  return pool.reduce((best, e) => (score(e) > score(best) ? e : best), pool[0]!);
}

interface Props {
  entry: CommunityCatalogEntry;
  coverUrl: string | null;
  onOpen: () => void;
  actions: ReactNode;
  children?: ReactNode;
}

export function FeaturedBanner({ entry, coverUrl, onOpen, actions, children }: Props) {
  const [shot, setShot] = useState(Boolean(coverUrl));
  // The owner's shared preview loop plays in the banner; no video (or 404) → the picture.
  const [noVideo, setNoVideo] = useState(false);
  const videoUrl = catalogCoverVideoUrl(entry, coverUrl, useColorScheme());
  const headline = entry.headline?.trim() || entry.description;
  return (
    <div className="cat-feat-wrap">
    <section
      className={`cat-feat${shot && coverUrl ? " has-shot" : ""}`}
      data-hover-play=""
      role="button"
      tabIndex={0}
      aria-label={`Featured: ${entry.name}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); }}
    >
      {shot && coverUrl ? (
        <span className="cat-feat__media">
          {videoUrl && !noVideo ? (
            <DemoVideo className="cat-feat__shot" src={videoUrl} poster={coverUrl} onError={() => setNoVideo(true)} />
          ) : (
            <img className="cat-feat__shot" src={coverUrl} alt="" draggable={false} onError={() => setShot(false)} />
          )}
        </span>
      ) : (
        <span className="cat-feat__big"><DropGlyph icon={entry.icon} title={entry.name} size={168} /></span>
      )}
      <div className="cat-feat__txt">
        <span className="cat-feat__k">App of the week</span>
        <h2 className="cat-feat__h">{headline}</h2>
        <div className="cat-feat__app">
          <DropGlyph icon={entry.icon} title={entry.name} size={52} />
          <div className="cat-feat__n"><b>{entry.name}</b><span>{entry.headline?.trim() && entry.description ? entry.description : catalogBy(entry)}</span></div>
          <span className="cat-feat__act">{actions}</span>
        </div>
      </div>
      {children}
    </section>
    </div>
  );
}
