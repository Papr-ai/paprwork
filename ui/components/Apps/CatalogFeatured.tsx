/**
 * Community "Featured" banner — App Store style: dark full-width card, a big
 * editorial headline (publisher-set `headline`, else the description), the
 * app's cover on the right, and a glass row with the droplet, name, by-line
 * and the same Open / Preview / Get buttons as the card.
 */
import { useState, type ReactNode } from "react";
import type { CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import { DropGlyph } from "./HomeTiles";
import { catalogBy } from "./CatalogAppDetails";
import "./CatalogFeatured.css";

/** Publisher headline first, then most installs; never your own app. */
export function pickFeaturedCatalogEntry(entries: CommunityCatalogEntry[]): CommunityCatalogEntry | null {
  const pool = entries.filter((e) => e.source === "cloud" && !e.isOwned && e.codeInstallable);
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
  const headline = entry.headline?.trim() || entry.description;
  return (
    <section
      className="cat-feat"
      role="button"
      tabIndex={0}
      aria-label={`Featured: ${entry.name}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); }}
    >
      {shot && coverUrl ? (
        <img className="cat-feat__shot" src={coverUrl} alt="" draggable={false} onError={() => setShot(false)} />
      ) : (
        <span className="cat-feat__big"><DropGlyph icon={entry.icon} title={entry.name} size={168} /></span>
      )}
      <div className="cat-feat__txt">
        <span className="cat-feat__k">Featured</span>
        <h2 className="cat-feat__h">{headline}</h2>
        <div className="cat-feat__app">
          <DropGlyph icon={entry.icon} title={entry.name} size={52} />
          <div className="cat-feat__n"><b>{entry.name}</b><span>{catalogBy(entry)}</span></div>
          <span className="cat-feat__act">{actions}</span>
        </div>
      </div>
      {children}
    </section>
  );
}
