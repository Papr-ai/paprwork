/**
 * Apps left rail: Library (what you have) and Discover (where to get more).
 * Replaces the My Apps / Team Apps / Community Apps tabs, which split apps by
 * where they came from instead of what the user is trying to do.
 */
import type { AppsSection, LibrarySection } from "../../utils/appsLibrary";

interface Item {
  id: AppsSection;
  label: string;
  icon: string;
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
    icon: "M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  },
  { id: "drafts", label: "Drafts", icon: "M5 19l1-4L16 5l3 3L9 18z" },
  {
    id: "automations",
    label: "Automations",
    icon: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
  },
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
    icon: "M9 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M17 12.3a2.3 2.3 0 1 0 0-4.6M16 14.6c2 .2 3.6 1.6 4.4 4.4",
  },
  {
    id: "community",
    label: "Community",
    icon: "m15.5 8.5-2 5-5 2 2-5zM21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
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
        viewBox="0 0 24 24"
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
