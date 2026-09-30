/**
 * Apps left rail: Library (what you have) and Discover (where to get more).
 * Replaces the My Apps / Team Apps / Community Apps tabs, which split apps by
 * where they came from instead of what the user is trying to do.
 */
import type { AppsSection, LibrarySection } from "../../utils/appsLibrary";
import { shareAudienceGlyphPath } from "../../utils/shareAudienceGlyphs";

interface Item {
  id: AppsSection;
  label: string;
  icon: string;
  /** Share-bar glyphs are drawn on a 16px grid; rail icons on 24px. */
  grid?: 16 | 24;
}

const LIBRARY: Item[] = [
  {
    id: "recent",
    label: "Recent",
    icon: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  },
  {
    id: "favorites",
    label: "Favorites",
    icon: "m12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7L9.6 9z",
  },
  {
    id: "live",
    label: "Live",
    // Broadcast waves — the globe is reserved for "anyone on the web" sharing.
    icon: "M12 12v.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8",
  },
  {
    id: "automations",
    label: "Automations",
    icon: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
  },
  { id: "drafts", label: "Drafts", icon: "M5 19l1-4L16 5l3 3L9 18z" },
  {
    id: "attention",
    label: "Needs attention",
    icon: "M12 4 3 19.5h18zM12 10v4M12 17v.01",
  },
  {
    id: "archived",
    label: "Archived",
    icon: "M4 5h16v4H4zM5.5 9v9.5h13V9M10 13h4",
  },
];

const DISCOVER: Item[] = [
  {
    id: "team",
    label: "Team",
    // Same glyphs as the share bar, so "Team" and "Community" read the same everywhere.
    icon: shareAudienceGlyphPath("team"),
    grid: 16,
  },
  {
    id: "community",
    label: "Community",
    icon: shareAudienceGlyphPath("public"),
    grid: 16,
  },
];

interface AppsSidebarProps {
  active: AppsSection | null;
  counts: Record<LibrarySection, number>;
  showTeam: boolean;
  onSelect: (section: AppsSection) => void;
}

function Row({
  item,
  active,
  count,
  onSelect,
}: {
  item: Item;
  active: boolean;
  count?: number;
  onSelect: (s: AppsSection) => void;
}) {
  const alert = item.id === "attention" && (count ?? 0) > 0;
  return (
    <button
      type="button"
      className={`apps-sidebar__item${active ? " apps-sidebar__item--active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(item.id)}
    >
      <svg
        className="apps-sidebar__icon"
        viewBox={item.grid === 16 ? "0 0 16 16" : "0 0 24 24"}
        style={item.grid === 16 ? { strokeWidth: 1.15 } : undefined}
        aria-hidden="true"
      >
        <path d={item.icon} />
      </svg>
      <span className="apps-sidebar__label">{item.label}</span>
      {count ? (
        <span
          className={`apps-sidebar__count${alert ? " apps-sidebar__count--alert" : ""}`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function AppsSidebar({
  active,
  counts,
  showTeam,
  onSelect,
}: AppsSidebarProps) {
  const discover = showTeam
    ? DISCOVER
    : DISCOVER.filter((i) => i.id !== "team");
  return (
    <nav className="apps-sidebar" aria-label="Apps">
      <div className="apps-sidebar__heading">Library</div>
      {LIBRARY.map((item) => (
        <Row
          key={item.id}
          item={item}
          active={active === item.id}
          count={counts[item.id as LibrarySection]}
          onSelect={onSelect}
        />
      ))}
      <div className="apps-sidebar__heading">Discover</div>
      {discover.map((item) => (
        <Row
          key={item.id}
          item={item}
          active={active === item.id}
          onSelect={onSelect}
        />
      ))}
    </nav>
  );
}
