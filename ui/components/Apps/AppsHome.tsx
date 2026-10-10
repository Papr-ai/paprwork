/**
 * My apps home (Apps page redesign): the library as a Home Screen.
 *
 *  - Automatic collections on top (Recent, Favorites, Live on the web) — they
 *    fill themselves and can't be dragged or renamed.
 *  - Then the user's own arrangement: collections (Papr-blue banner, up to six
 *    apps) and single apps (cover or banner, overlapping icon, one status line).
 *  - First run seeds collections from Jev categories with 3+ apps. Nothing is
 *    saved until the user moves something; apps the saved layout has never seen
 *    show first as "New", with a one-click "Move to <category>".
 *  - Drag an app onto another app to make a collection, onto a collection to
 *    file it, between cards to reorder. Arranged / A–Z switch.
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import type { AppsHealthMap } from "../../../src/core/utils/appsHealth";
import type { ShareGlyph } from "../../utils/shareGlyph";
import { isIdLikeTitle, needsAttention, type LibrarySection } from "../../utils/appsLibrary";
import {
  dropOnItem,
  fileIntoCategory,
  fileTargetFor,
  isFolderId,
  loadHomeLayout,
  moveIntoFolder,
  moveToTopLevel,
  reconcileLayout,
  relativeWhen,
  renameFolder,
  saveHomeLayout,
  seedLayout,
  ungroupFolder,
  withoutIds,
  type DropZone,
  type HomeLayout,
} from "../../utils/appsHome";
import { AppTile, CollectionTile, type TileDnd } from "./HomeTiles";
import { HomeMenu, type HomeMenuItem } from "./HomeMenu";
import { HomeCollectionSheet } from "./HomeCollectionSheet";
import { HomeIcon, type HomeIconName } from "./HomeIcon";
import type { LibraryCardHandlers } from "./LibraryPane";
import { appStatusLine } from "../../utils/appStatusLine";
import "./AppsHome.css";

const SMART: Array<{ id: string; name: string; icon: HomeIconName }> = [
  { id: "s:recent", name: "Recent", icon: "clock" },
  { id: "s:fav", name: "Favorites", icon: "star" },
  { id: "s:live", name: "Live on the web", icon: "globe" },
];

interface AppsHomeProps extends LibraryCardHandlers {
  /** Library, newest first (archived included; filtered here). */
  apps: Artifact[];
  health: AppsHealthMap;
  publishedIds: ReadonlySet<string>;
  shareById: Readonly<Record<string, ShareGlyph>>;
  categoryOf: (appId: string) => string | null;
  /** localStorage key for this workspace's arrangement. */
  storageKey: string;
  showCopyAction: boolean;
  showTeam: boolean;
  duplicateExtraCount: number;
  onStartCleanup: () => void;
  onSelectSection: (s: LibrarySection | "team" | "community") => void;
}

const lastSeen = (a: Artifact) => a.lastOpenedAt ?? a.updatedAt;

export function AppsHome(p: AppsHomeProps) {
  const active = useMemo(() => p.apps.filter((a) => (a.status ?? "active") !== "archived"), [p.apps]);
  const byId = useMemo(() => new Map(active.map((a) => [a.id, a])), [active]);
  const archivedCount = p.apps.length - active.length;
  const attention = useCallback((a: Artifact) => needsAttention(a, p.health[a.id]), [p.health]);

  const [saved, setSaved] = useState<HomeLayout | null>(() => loadHomeLayout(p.storageKey));
  useEffect(() => setSaved(loadHomeLayout(p.storageKey)), [p.storageKey]);
  const [mode, setMode] = useState<"grid" | "az">(() =>
    localStorage.getItem(`${p.storageKey}:mode`) === "az" ? "az" : "grid",
  );
  const [openFolder, setOpenFolder] = useState<{ id: string; fresh: boolean } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; zone: DropZone } | null>(null);

  const ids = useMemo(() => active.map((a) => a.id), [active]);
  const { layout, added } = useMemo(() => {
    if (!saved) return { layout: seedLayout(ids, p.categoryOf), added: [] as string[] };
    return reconcileLayout(saved, ids);
  }, [saved, ids, p.categoryOf]);
  const isNew = useCallback((id: string) => added.includes(id), [added]);

  /** Save a change. Apps nobody has placed yet stay "New" (they are left out of the saved layout). */
  const save = useCallback(
    (next: HomeLayout, placedId?: string) => {
      const out = withoutIds(next, added.filter((id) => id !== placedId));
      setSaved(out);
      saveHomeLayout(p.storageKey, out);
    },
    [added, p.storageKey],
  );
  const commit = (next: HomeLayout) => save(next);
  const place = (next: HomeLayout, placedId: string) => save(next, placedId);

  const folders = useMemo(
    () => Object.entries(layout.folders).map(([id, f]) => ({ id, name: f.name })),
    [layout.folders],
  );
  const folderOfApp = useCallback(
    (id: string) => Object.keys(layout.folders).find((k) => layout.folders[k]!.ids.includes(id)) ?? null,
    [layout.folders],
  );

  const smartApps = useCallback(
    (id: string): Artifact[] => {
      if (id === "s:recent") return active.slice(0, 8);
      if (id === "s:fav") return active.filter((a) => a.favorite);
      if (id === "s:live") return active.filter((a) => p.publishedIds.has(a.id));
      return [];
    },
    [active, p.publishedIds],
  );

  // ── Drag and drop ──────────────────────────────────────────────────────────
  const dnd: TileDnd = {
    dragging,
    hover,
    onDragStart: (id, e, app) => {
      setDragging(id);
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/plain", id);
      if (app) {
        // Same payload as AppCard so an app can still be dropped into a chat.
        e.dataTransfer.setData(
          "application/json",
          JSON.stringify({ id: app.id, type: app.type, title: app.title, ...(app.icon ? { icon: app.icon } : {}) }),
        );
      }
    },
    onDragOver: (id, e, acceptsInto) => {
      if (!dragging || dragging === id) return;
      e.preventDefault();
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const zone: DropZone =
        !acceptsInto || isFolderId(dragging) ? (x < 0.5 ? "before" : "after") : x < 0.28 ? "before" : x > 0.72 ? "after" : "into";
      if (hover?.id !== id || hover.zone !== zone) setHover({ id, zone });
    },
    onDrop: (id, e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dragging || !hover || hover.id !== id) return endDrag();
      const target = id;
      const { layout: next, created } = dropOnItem(layout, dragging, target, hover.zone, nameForNewCollection(dragging, target));
      place(next, dragging);
      if (created) setOpenFolder({ id: created, fresh: true });
      endDrag();
    },
    onDragEnd: () => endDrag(),
  };
  function endDrag() {
    setDragging(null);
    setHover(null);
  }
  function nameForNewCollection(a: string, b: string): string {
    const ca = p.categoryOf(a);
    return ca && ca !== "Other" && ca === p.categoryOf(b) ? ca : "New collection";
  }
  const onGridDrop = (e: DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    place(moveToTopLevel(layout, dragging), dragging);
    endDrag();
  };

  // ── Menus ──────────────────────────────────────────────────────────────────
  const menuFor = (a: Artifact, inFolder: string | null) => {
    const items: HomeMenuItem[] = [
      { label: "Open", onSelect: () => p.onOpen(a) },
      { label: "Rename", onSelect: () => setRenamingId(a.id) },
      { label: "Move to collection…", onSelect: () => undefined },
    ];
    if (inFolder) {
      items.push({ label: "Take out of collection", onSelect: () => place(moveToTopLevel(layout, a.id), a.id) });
    }
    items.push({ label: a.favorite ? "Remove from Favorites" : "Add to Favorites", onSelect: () => p.onToggleFavorite(a.id) });
    if (attention(a)) items.push({ label: "Fix with Pen", onSelect: () => p.onFix(a) });
    if (p.showCopyAction) items.push({ label: "Copy to workspace…", onSelect: () => p.onCopy(a) });
    items.push({ label: "—", onSelect: () => undefined });
    items.push({ label: "Archive", onSelect: () => p.onSetStatus(a.id, "archived") });
    items.push({ label: "Delete app", danger: true, onSelect: () => p.onDelete(a.id) });
    const current = inFolder ?? folderOfApp(a.id);
    return (
      <HomeMenu
        items={items}
        moveTargets={folders.filter((f) => f.id !== current)}
        onMove={(fid) => place(moveIntoFolder(layout, a.id, fid), a.id)}
      />
    );
  };

  const status = (a: Artifact) => {
    const h = p.health[a.id];
    const line = appStatusLine(a, { health: h, isPublished: p.publishedIds.has(a.id) });
    if (h?.state === "failed") {
      const when = line.text.split(":")[0] ?? "";
      return { text: when || "Automation failing", bad: true };
    }
    if (isIdLikeTitle(a.title)) return { text: "Needs a name", bad: true };
    if (line.text) return { text: line.text, bad: false };
    if (a.status === "draft" && !p.publishedIds.has(a.id)) return { text: "Draft", bad: false };
    return null;
  };
  const appTile = (a: Artifact) => {
    const fresh = isNew(a.id);
    const moveTo = fresh ? fileTargetFor(layout, a.id, p.categoryOf) : null;
    return (
      <AppTile
        key={a.id}
        app={a}
        isNew={fresh}
        status={status(a)}
        meta={`${a.lastOpenedAt ? "Opened" : "Updated"} ${relativeWhen(lastSeen(a))}`}
        moveTo={moveTo}
        share={p.shareById[a.id]}
        dnd={dnd}
        renaming={renamingId === a.id}
        onOpen={() => p.onOpen(a)}
        onMove={() => {
          if (!moveTo) return;
          const next = fileIntoCategory(layout, a.id, moveTo, p.categoryOf);
          if (next) place(next, a.id);
        }}
        onRename={(t) => p.onRename(a.id, t)}
        onRenameDone={() => setRenamingId(null)}
        menu={menuFor(a, null)}
      />
    );
  };
  const collection = (id: string, name: string, apps: Artifact[], auto: HomeIconName | null) =>
    apps.length === 0 ? null : (
      <CollectionTile
        key={id}
        id={id}
        name={name}
        icon={auto ?? "layers"}
        apps={apps}
        auto={auto !== null}
        dnd={dnd}
        attention={attention}
        shareById={p.shareById}
        renamingId={renamingId}
        onOpenApp={p.onOpen}
        onOpenCollection={() => setOpenFolder({ id, fresh: false })}
        onRename={(a, t) => p.onRename(a.id, t)}
        onRenameDone={() => setRenamingId(null)}
        menuFor={menuFor}
      />
    );

  // ── Status pills (replace the two banners) ─────────────────────────────────
  const bad = active.filter(attention).length;
  const pills = (
    <div className="ah-pills">
      {bad > 0 ? (
        <button type="button" className="ah-pill ah-pill--bad" onClick={() => p.onSelectSection("attention")}>
          <i />
          {bad} need{bad === 1 ? "s" : ""} attention
        </button>
      ) : null}
      {p.duplicateExtraCount > 0 ? (
        <button type="button" className="ah-pill" onClick={p.onStartCleanup}>
          <HomeIcon name="layers" size={13} />
          {p.duplicateExtraCount} duplicates
        </button>
      ) : null}
    </div>
  );

  const setView = (m: "grid" | "az") => {
    setMode(m);
    try {
      localStorage.setItem(`${p.storageKey}:mode`, m);
    } catch {
      /* noop */
    }
  };

  const sheet = (() => {
    if (!openFolder) return null;
    const smart = SMART.find((s) => s.id === openFolder.id);
    const f = layout.folders[openFolder.id];
    if (!smart && !f) return null;
    const apps = smart ? smartApps(smart.id) : f!.ids.map((x) => byId.get(x)).filter((a): a is Artifact => !!a);
    return (
      <HomeCollectionSheet
        name={smart ? smart.name : f!.name}
        readOnly={Boolean(smart)}
        apps={apps}
        autoFocusName={openFolder.fresh}
        dnd={{
          ...dnd,
          onDrop: (id, e) => {
            if (smart) return endDrag();
            dnd.onDrop(id, e);
          },
          onDragOver: (id, e) => (smart ? undefined : dnd.onDragOver(id, e, false)),
        }}
        attention={attention}
        renamingId={renamingId}
        onRenameFolder={(n) => commit(renameFolder(layout, openFolder.id, n))}
        onUngroup={() => {
          commit(ungroupFolder(layout, openFolder.id));
          setOpenFolder(null);
        }}
        onDropOut={() => {
          if (smart || !dragging) return endDrag();
          place(moveToTopLevel(layout, dragging), dragging);
          endDrag();
        }}
        onClose={() => setOpenFolder(null)}
        onOpenApp={(a) => {
          setOpenFolder(null);
          p.onOpen(a);
        }}
        onRenameApp={(a, t) => p.onRename(a.id, t)}
        onRenameDone={() => setRenamingId(null)}
        menuFor={(a) => menuFor(a, smart ? null : openFolder.id)}
      />
    );
  })();

  // Untitled (recovered) apps go last, the rest A–Z.
  const byName = (a: Artifact, b: Artifact) =>
    Number(isIdLikeTitle(a.title)) - Number(isIdLikeTitle(b.title)) ||
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

  return (
    <div className="ah">
      <div className="ah-head">
        <h1 className="ah-title">My apps</h1>
        {pills}
        <div className="ah-seg" role="tablist" aria-label="Arrange">
          <button type="button" role="tab" aria-selected={mode === "grid"} className={mode === "grid" ? "is-on" : ""} onClick={() => setView("grid")}>
            Arranged
          </button>
          <button type="button" role="tab" aria-selected={mode === "az"} className={mode === "az" ? "is-on" : ""} onClick={() => setView("az")}>
            A–Z
          </button>
        </div>
      </div>

      {mode === "az" ? (
        <div className="ah-grid">{[...active].sort(byName).map(appTile)}</div>
      ) : (
        <div
          className="ah-grid"
          onDragOver={(e) => dragging && e.preventDefault()}
          onDrop={(e) => e.target === e.currentTarget && onGridDrop(e)}
        >
          {added.map((id) => byId.get(id)).filter((a): a is Artifact => !!a).map(appTile)}
          {SMART.map((s) => collection(s.id, s.name, smartApps(s.id), s.icon))}
          {layout.order.map((id) => {
            if (added.includes(id)) return null;
            const f = layout.folders[id];
            if (f) {
              const apps = f.ids.map((x) => byId.get(x)).filter((a): a is Artifact => !!a);
              return collection(id, f.name, apps, null);
            }
            const a = byId.get(id);
            return a ? appTile(a) : null;
          })}
        </div>
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
          <button type="button" onClick={() => p.onSelectSection("drafts")}>
            <HomeIcon name="pencil" size={14} />
            Drafts
          </button>
        </div>
        <div className="ah-foot__doors">
          <span>Need another app?</span>
          {p.showTeam ? (
            <button type="button" onClick={() => p.onSelectSection("team")}>
              <HomeIcon name="users" size={14} />
              Team apps
            </button>
          ) : null}
          <button type="button" onClick={() => p.onSelectSection("community")}>
            <HomeIcon name="globe" size={14} />
            Community apps
          </button>
        </div>
      </footer>
      {sheet}
    </div>
  );
}
