/**
 * Library side of the Apps page: one section at a time (Recent, Live, …),
 * status lines on every card, near-duplicates stacked, and banners that
 * point at the two things worth fixing (failing apps, duplicate copies).
 */
import { useMemo, useState } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import type { AppsHealthMap } from "../../../src/core/utils/appsHealth";
import { AppCard, type AppStatus } from "./AppCard";
import { appStatusLine } from "../../utils/appStatusLine";
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
  live: ["Live", "Published to the web — anyone with access can open these."],
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
}

interface LibraryPaneProps extends LibraryCardHandlers {
  section: LibrarySection;
  apps: Artifact[];
  health: AppsHealthMap;
  publishedIds: ReadonlySet<string>;
  searchQuery: string;
  showCopyAction: boolean;
  duplicateExtraCount: number;
  onSelectSection: (s: LibrarySection) => void;
  onStartCleanup: () => void;
}

export function LibraryPane(props: LibraryPaneProps) {
  const { section, apps, health, publishedIds, searchQuery } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const ctx = useMemo(() => ({ publishedIds, health }), [publishedIds, health]);
  const searching = searchQuery.trim().length > 0;

  const list = useMemo(
    () => apps.filter((a) => (searching ? true : inSection(a, section, ctx))),
    [apps, section, ctx, searching],
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

      {visible.length === 0 ? (
        <p className="apps-view__none">
          {searching ? "No apps in your library match." : "Nothing here."}
        </p>
      ) : (
        <div className="apps-view__grid">
          {visible.map((app) => {
            const k = duplicateKey(app.title);
            const copies =
              stackable && k && !expanded.has(k)
                ? (stackSize.get(k) ?? 1) - 1
                : 0;
            return (
              <AppCard
                key={app.id}
                artifact={app}
                isPublished={publishedIds.has(app.id)}
                statusLine={appStatusLine(app, {
                  health: health[app.id],
                  isPublished: publishedIds.has(app.id),
                })}
                duplicateCount={copies}
                onShowDuplicates={() =>
                  k && setExpanded((s) => new Set(s).add(k))
                }
                onOpen={() => props.onOpen(app)}
                onDelete={() => props.onDelete(app.id)}
                onToggleFavorite={() => props.onToggleFavorite(app.id)}
                onRename={(t) => props.onRename(app.id, t)}
                onSetStatus={(s) => props.onSetStatus(app.id, s)}
                showCopyAction={props.showCopyAction}
                onCopy={() => props.onCopy(app)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
