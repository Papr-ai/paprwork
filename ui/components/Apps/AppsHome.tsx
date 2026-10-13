/**
 * My apps home: a launcher, built for finding — not browsing.
 *
 *  - Narrow page, two columns of connector-style cards: droplet · name · one
 *    line about it · one status line. The card opens the app; ⋯ on hover.
 *  - Recent (last 4 opened) → New from your team → All apps (A–Z).
 *  - Chips filter in place: All · Favorites · Team apps · Needs attention · categories · Live.
 *  - Under Recent: the newest 4 team apps you don't have yet + "Show all" (= the Team apps chip).
 *  - Covers / preview videos live on Discover and in App info, not here.
 */
import { useCallback, useMemo, useState } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import type { AppsHealthMap } from "../../../src/core/utils/appsHealth";
import type { ShareGlyph } from "../../utils/shareGlyph";
import { isIdLikeTitle, needsAttention, type LibrarySection } from "../../utils/appsLibrary";
import { relativeWhen } from "../../utils/appsHome";
import { HomeMenu, type HomeMenuItem } from "./HomeMenu";
import { TeamAppsCollection } from "./TeamAppsCollection";
import { HomeIcon } from "./HomeIcon";
import { AppRow } from "./HomeRows";
import type { LibraryCardHandlers } from "./LibraryPane";
import { homeStatus } from "../../utils/homeStatus";
import "./AppsHome.css";
import { startDemoGeneration, useAppDemoIds } from "../../utils/appDemo";

const RECENT = 4;

interface AppsHomeProps extends LibraryCardHandlers {
  /** Library (archived included; filtered here). */
  apps: Artifact[];
  health: AppsHealthMap;
  publishedIds: ReadonlySet<string>;
  shareById: Readonly<Record<string, ShareGlyph>>;
  categoryOf: (appId: string) => string | null;
  /** localStorage key for this workspace (kept for callers; layout is automatic now). */
  storageKey: string;
  showCopyAction: boolean;
  showTeam: boolean;
  /** Team workspace: "From <team>" section of team apps you don't have yet. */
  teamNamespaceId?: string | null;
  teamName?: string | null;
  duplicateExtraCount: number;
  onStartCleanup: () => void;
  onSelectSection: (s: LibrarySection | "team" | "community") => void;
}

const lastSeen = (a: Artifact) => a.lastOpenedAt ?? a.updatedAt;
const byName = (a: Artifact, b: Artifact) =>
  Number(isIdLikeTitle(a.title)) - Number(isIdLikeTitle(b.title)) ||
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

type Filter = "all" | "pin" | "team" | "bad" | "live" | `cat:${string}`;

export function AppsHome(p: AppsHomeProps) {
  const active = useMemo(() => p.apps.filter((a) => (a.status ?? "active") !== "archived"), [p.apps]);
  const archivedCount = p.apps.length - active.length;
  const attention = useCallback((a: Artifact) => needsAttention(a, p.health[a.id]), [p.health]);
  const [filter, setFilter] = useState<Filter>("all");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const demoIds = useAppDemoIds();

  const cats = useMemo(() => {
    const n = new Map<string, number>();
    for (const a of active) {
      const c = p.categoryOf(a.id);
      if (c && c !== "Other") n.set(c, (n.get(c) ?? 0) + 1);
    }
    return [...n].filter(([, k]) => k >= 2).sort((x, y) => y[1] - x[1]).map(([c]) => c);
  }, [active, p.categoryOf]);

  const matches = (a: Artifact): boolean => {
    if (filter === "all") return true;
    if (filter === "pin") return Boolean(a.favorite);
    if (filter === "bad") return attention(a);
    if (filter === "live") return p.publishedIds.has(a.id);
    return p.categoryOf(a.id) === filter.slice(4);
  };

  const menuFor = (a: Artifact) => {
    const items: HomeMenuItem[] = [
      { label: "Open", onSelect: () => p.onOpen(a) },
      { label: "Rename", onSelect: () => setRenamingId(a.id) },
      { label: a.favorite ? "Remove from Favorites" : "Add to Favorites", onSelect: () => p.onToggleFavorite(a.id) },
    ];
    if (attention(a)) items.push({ label: "Fix with Pen", onSelect: () => p.onFix(a) });
    if (p.showCopyAction) items.push({ label: "Copy to workspace…", onSelect: () => p.onCopy(a) });
    items.push({
      label: demoIds.has(a.id) ? "Make a new preview video" : "Make preview video",
      onSelect: () => void startDemoGeneration(a.id).catch(() => undefined),
    });
    items.push({ label: "—", onSelect: () => undefined });
    items.push({ label: "Archive", onSelect: () => p.onSetStatus(a.id, "archived") });
    items.push({ label: "Delete app", danger: true, onSelect: () => p.onDelete(a.id) });
    return <HomeMenu items={items} moveTargets={[]} onMove={() => undefined} />;
  };

  const row = (a: Artifact) => (
    <AppRow
      key={a.id}
      app={a}
      status={homeStatus(a, p.health[a.id], p.publishedIds.has(a.id))}
      meta={`${a.lastOpenedAt ? "Opened" : "Updated"} ${relativeWhen(lastSeen(a))}`}
      share={p.shareById[a.id]}
      renaming={renamingId === a.id}
      onOpen={() => p.onOpen(a)}
      onRename={(t) => p.onRename(a.id, t)}
      onRenameDone={() => setRenamingId(null)}
      menu={menuFor(a)}
    />
  );
  const section = (title: string, apps: Artifact[], count?: number) =>
    apps.length === 0 ? null : (
      <section className="ah-sec" aria-label={title}>
        <h2 className="ah-sec__h">
          {title}
          {count ? <em>{count}</em> : null}
        </h2>
        <div className="ah-rows">{apps.map(row)}</div>
      </section>
    );

  const shown = active.filter(matches);
  const byRecent = [...shown].sort((x, y) => lastSeen(y).localeCompare(lastSeen(x)));
  const recent = filter === "all" && shown.length > RECENT + 2 ? byRecent.slice(0, RECENT) : [];
  const rest = shown.filter((a) => !recent.includes(a)).sort(byName);

  const hasTeam = Boolean(p.showTeam && p.teamNamespaceId);
  const teamSection = (mode: "preview" | "all") =>
    hasTeam ? (
      <TeamAppsCollection
        namespaceId={p.teamNamespaceId!}
        namespaceName={p.teamName ?? null}
        mode={mode}
        onShowAll={() => setFilter("team")}
      />
    ) : null;
  const bad = active.filter(attention).length;
  const pinned = active.filter((a) => a.favorite).length;
  const chip = (f: Filter, label: React.ReactNode, cls = "") => (
    <button type="button" key={f} className={`ah-chip${filter === f ? " is-on" : ""} ${cls}`} onClick={() => setFilter(f)}>
      {label}
    </button>
  );

  return (
    <div className="ah ah--rows">
      <div className="ah-head">
        <h1 className="ah-title">My apps</h1>
        {p.duplicateExtraCount > 0 ? (
          <button type="button" className="ah-quiet" onClick={p.onStartCleanup}>
            <HomeIcon name="layers" size={13} />
            Clean up {p.duplicateExtraCount} duplicate{p.duplicateExtraCount === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>

      <div className="ah-chips" role="toolbar" aria-label="Filter apps">
        {chip("all", "All")}
        {pinned ? chip("pin", <><HomeIcon name="star" size={13} />Favorites</>) : null}
        {hasTeam ? chip("team", <><HomeIcon name="users" size={13} />Team apps</>) : null}
        {bad ? chip("bad", <><i className="ah-chip__dot" />Needs attention <em>{bad}</em></>, "ah-chip--bad") : null}
        {cats.length ? <span className="ah-chips__sep" /> : null}
        {cats.map((c) => chip(`cat:${c}`, c))}
        {p.publishedIds.size ? <span className="ah-chips__sep" /> : null}
        {p.publishedIds.size ? chip("live", <><HomeIcon name="globe" size={13} />Live</>) : null}
      </div>

      {filter === "team" ? (
        teamSection("all")
      ) : (
        <>
          {shown.length === 0 ? <p className="ah-sec__none">Nothing here.</p> : null}
          {section("Recent", recent)}
          {filter === "all" ? teamSection("preview") : null}
          {section(recent.length ? "All apps" : filter === "all" ? "All apps" : "Apps", rest, recent.length ? rest.length : undefined)}
        </>
      )}

      <footer className="ah-foot">
        <div className="ah-foot__links">
          {archivedCount > 0 ? (
            <button type="button" onClick={() => p.onSelectSection("archived")}>
              <HomeIcon name="archive" size={14} />
              Archived <em>{archivedCount}</em>
            </button>
          ) : null}
          <button type="button" onClick={() => p.onSelectSection("automations")}>
            <HomeIcon name="bolt" size={14} />
            Automations
          </button>
        </div>
        <div className="ah-foot__doors">
          <span>Need another app?</span>
          <button type="button" onClick={() => p.onSelectSection("community")}>
            <HomeIcon name="globe" size={14} />
            Discover
          </button>
        </div>
      </footer>
    </div>
  );
}
