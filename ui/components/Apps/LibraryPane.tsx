/**
 * Library side of the Apps page: one section at a time (Recent, Live, …),
 * status lines on every card, near-duplicates stacked, and banners that
 * point at the two things worth fixing (failing apps, duplicate copies).
 */
import { useEffect, useMemo, useState } from "react";
import { useAppCategories } from "../../hooks/useAppCategories";
import { CategoryPills, matchesCategory } from "./CategoryPills";
import type { Artifact } from "../../stores/artifactsStore";
import type { AppsHealthMap } from "../../../src/core/utils/appsHealth";
import type { AppStatus } from "./AppCard";
import { AppTile, type TileDnd } from "./HomeTiles";
import { HomeMenu, type HomeMenuItem } from "./HomeMenu";
import { homeStatus } from "../../utils/homeStatus";
import { relativeWhen } from "../../utils/appsHome";
import "./AppsHome.css";

const NO_DND: TileDnd = {
  dragging: null,
  hover: null,
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDrop: () => undefined,
  onDragEnd: () => undefined,
};
import type { ShareGlyph } from "../../utils/shareGlyph";
import {
  duplicateKey,
  inSection,
  needsAttention,
  type LibrarySection,
} from "../../utils/appsLibrary";

const HEADINGS: Record<LibrarySection, [string, string]> = {
  recent: [
    "Recent",
    "Everything you use, newest first. Near-duplicate copies are stacked.",
  ],
  favorites: ["Favorites", "Apps you starred."],
  live: ["Shared", "Apps other people can open — your team, specific people, or anyone with the link."],
  drafts: ["Drafts", "Only you can see these until you publish."],
  automations: [
    "Automations",
    "Apps with scheduled jobs, and how the last run went.",
  ],
  attention: [
    "Needs attention",
    "Failing automations and apps that lost their name.",
  ],
  archived: ["Archived", "Out of the way, never deleted. Restore any time."],
};

export interface LibraryCardHandlers {
  onOpen: (app: Artifact) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onSetStatus: (id: string, status: AppStatus) => void;
  onCopy: (app: Artifact) => void;
  onFix: (app: Artifact) => void;
}

interface LibraryPaneProps extends LibraryCardHandlers {
  section: LibrarySection;
  apps: Artifact[];
  health: AppsHealthMap;
  publishedIds: ReadonlySet<string>;
  shareById: Readonly<Record<string, ShareGlyph>>;
  searchQuery: string;
  showCopyAction: boolean;
  duplicateExtraCount: number;
  onSelectSection: (s: LibrarySection) => void;
  onStartCleanup: () => void;
  /** Unified search page: just "In your library" + matches, no page heading. */
  resultsOnly?: boolean;
}

export function LibraryPane(props: LibraryPaneProps) {
  const { section, apps, health, publishedIds, searchQuery } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const sharedIds = useMemo(
    () => new Set(Object.keys(props.shareById).filter((id) => props.shareById[id]?.audience !== "private")),
    [props.shareById],
  );
  const ctx = useMemo(() => ({ publishedIds, sharedIds, health }), [publishedIds, sharedIds, health]);
  const searching = searchQuery.trim().length > 0;

  const sectionList = useMemo(
    () => apps.filter((a) => (searching ? true : inSection(a, section, ctx))),
    [apps, section, ctx, searching],
  );

  // Broad category pills (Jev-sorted). Reset when the section changes.
  const { snapshot: cats, sorting } = useAppCategories();
  const [category, setCategory] = useState<string | null>(null);
  useEffect(() => setCategory(null), [section]);
  const list = useMemo(
    () =>
      searching || category === null
        ? sectionList
        : sectionList.filter((a) => matchesCategory(`app:${a.id}`, cats.byKey, category)),
    [sectionList, cats.byKey, category, searching],
  );

  // Stack copies behind the most recent one (list is already sorted by recency).
  const stackable =
    !searching && (section === "recent" || section === "drafts");
  const { visible, stackSize } = useMemo(() => {
    const size = new Map<string, number>();
    for (const a of list) {
      const k = duplicateKey(a.title);
      if (k) size.set(k, (size.get(k) ?? 0) + 1);
    }
    if (!stackable) return { visible: list, stackSize: size };
    const seen = new Set<string>();
    const out = list.filter((a) => {
      const k = duplicateKey(a.title);
      if (!k || (size.get(k) ?? 0) < 2 || expanded.has(k)) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { visible: out, stackSize: size };
  }, [list, stackable, expanded]);

  const failing = apps.filter((a) => needsAttention(a, health[a.id])).length;
  const [title, subtitle] = searching
    ? [
        `Results for “${searchQuery.trim()}”`,
        "In your library. Team and Community are searched from their own sections.",
      ]
    : HEADINGS[section];

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const menuFor = (app: Artifact) => {
    const archived = (app.status ?? "active") === "archived";
    const items: HomeMenuItem[] = [
      { label: "Open", onSelect: () => props.onOpen(app) },
      { label: "Rename", onSelect: () => setRenamingId(app.id) },
      {
        label: app.favorite ? "Remove from Favorites" : "Add to Favorites",
        onSelect: () => props.onToggleFavorite(app.id),
      },
    ];
    if (needsAttention(app, health[app.id])) items.push({ label: "Fix with Pen", onSelect: () => props.onFix(app) });
    if (props.showCopyAction) items.push({ label: "Copy to workspace…", onSelect: () => props.onCopy(app) });
    items.push({ label: "—", onSelect: () => undefined });
    items.push(
      archived
        ? { label: "Restore", onSelect: () => props.onSetStatus(app.id, "active") }
        : { label: "Archive", onSelect: () => props.onSetStatus(app.id, "archived") },
    );
    items.push({ label: "Delete app", danger: true, onSelect: () => props.onDelete(app.id) });
    return <HomeMenu items={items} moveTargets={[]} onMove={() => undefined} />;
  };

  // Same card as the My apps home (droplet logo, status line, Open, ⋯).
  const renderCard = (app: Artifact) => {
    const k = duplicateKey(app.title);
    const copies = stackable && k && !expanded.has(k) ? (stackSize.get(k) ?? 1) - 1 : 0;
    return (
      <AppTile
        key={app.id}
        app={app}
        isNew={false}
        status={homeStatus(app, health[app.id], publishedIds.has(app.id))}
        meta={`${app.lastOpenedAt ? "Opened" : "Updated"} ${relativeWhen(app.lastOpenedAt ?? app.updatedAt)}`}
        moveTo={null}
        share={props.shareById[app.id]}
        dnd={NO_DND}
        static
        renaming={renamingId === app.id}
        onOpen={() => props.onOpen(app)}
        onMove={() => undefined}
        onRename={(t) => props.onRename(app.id, t)}
        onRenameDone={() => setRenamingId(null)}
        menu={menuFor(app)}
        extra={
          copies > 0 ? (
            <button
              type="button"
              className="ah-copies"
              onClick={() => k && setExpanded((x) => new Set(x).add(k))}
            >
              +{copies} {copies === 1 ? "copy" : "copies"}
            </button>
          ) : null
        }
      />
    );
  };

  if (props.resultsOnly) {
    return visible.length === 0 ? null : (
      <section className="apps-view__results">
        <h2 className="apps-view__results-title">
          In your library <em>{visible.length}</em>
        </h2>
        <div className="ah ah-list">{visible.map(renderCard)}</div>
      </section>
    );
  }

  return (
    <>
      <div className="apps-view__page-head">
        <h1 className="apps-view__page-title">{title}</h1>
        <p className="apps-view__page-subtitle">{subtitle}</p>
      </div>

      {section === "recent" &&
      !searching &&
      (failing > 0 || props.duplicateExtraCount > 0) ? (
        <div className="apps-view__banners">
          {failing > 0 ? (
            <div className="apps-view__banner apps-view__banner--warn">
              <span>
                <strong>
                  {failing} {failing === 1 ? "app needs" : "apps need"}{" "}
                  attention
                </strong>{" "}
                — failing automations or missing names.
              </span>
              <button
                type="button"
                onClick={() => props.onSelectSection("attention")}
              >
                Review
              </button>
            </div>
          ) : null}
          {props.duplicateExtraCount > 0 ? (
            <div className="apps-view__banner">
              <span>
                <strong>
                  {props.duplicateExtraCount} near-duplicate copies
                </strong>{" "}
                in your library.
              </span>
              <button type="button" onClick={props.onStartCleanup}>
                Clean up
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!searching && sorting && sectionList.length >= 6 ? (
        <div className="category-pills category-pills--reserve" aria-hidden="true" />
      ) : !searching ? (
        <CategoryPills
          keys={sectionList.map((a) => `app:${a.id}`)}
          byKey={cats.byKey}
          order={cats.categories.map((c) => c.name)}
          value={category}
          onChange={setCategory}
        />
      ) : null}

      {visible.length === 0 ? (
        <p className="apps-view__none">
          {searching ? "No apps in your library match." : "Nothing here."}
        </p>
      ) : (
        <div className="ah ah-list">{visible.map(renderCard)}</div>
      )}
    </>
  );
}
