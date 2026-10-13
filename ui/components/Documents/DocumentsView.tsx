/**
 * Documents — same launcher as My apps: narrow page, two columns of cards
 * (icon · title · first line · one status line). The card opens it; ⋯ on hover.
 * Recent (last 4 edited) → All documents (A–Z). Chips: All · Favorites · Archived.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { gateway } from "../../src/lib/gateway";
import type { Artifact } from "../../stores/artifactsStore";
import { markdownPreviewText } from "../../../src/core/utils/markdownPreview";
import { relativeWhen } from "../../utils/appsHome";
import { HomeMenu, type HomeMenuItem } from "../Apps/HomeMenu";
import { HomeIcon } from "../Apps/HomeIcon";
import "../Apps/AppsHome.css";
import "./DocumentsView.css";

type Filter = "all" | "fav" | "archived";
const RECENT = 4;
const byName = (a: Artifact, b: Artifact) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
const newest = (a: Artifact, b: Artifact) => b.updatedAt.localeCompare(a.updatedAt);

function DocIcon() {
  return (
    <span className="dv-ic" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path d="M14 2v6h6M8 13h8M8 17h5" />
      </svg>
    </span>
  );
}

function DocRow(p: { doc: Artifact; renaming: boolean; onOpen: () => void; onRename: (t: string) => void; onDone: () => void; menu: React.ReactNode }) {
  const [value, setValue] = useState(p.doc.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!p.renaming) return;
    setValue(p.doc.title);
    requestAnimationFrame(() => ref.current?.select());
  }, [p.renaming, p.doc.title]);
  const preview = useMemo(() => (p.doc.preview ? markdownPreviewText(p.doc.preview) : ""), [p.doc.preview]);
  const words = p.doc.wordCount ? `${p.doc.wordCount.toLocaleString()} words` : "";
  const status = [p.doc.archived ? "Archived" : "", `Edited ${relativeWhen(p.doc.updatedAt)}`, words].filter(Boolean).join(" · ");
  const commit = () => {
    const t = value.trim();
    if (t && t !== p.doc.title) p.onRename(t);
    p.onDone();
  };
  return (
    <div className="ah-row">
      <button type="button" className="ah-row__main" onClick={p.renaming ? undefined : p.onOpen} title={p.doc.title}>
        <span className="ah-row__ic"><DocIcon /></span>
        <span className="ah-row__txt">
          <span className="ah-row__t">
            {p.renaming ? (
              <input
                ref={ref}
                className="ah-row__name dv-rename"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={commit}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") p.onDone();
                }}
              />
            ) : (
              <span className="ah-row__name">{p.doc.title || "Untitled document"}</span>
            )}
            {p.doc.favorite ? <HomeIcon name="star" size={13} className="ah-row__pin" /> : null}
          </span>
          {preview ? <span className="ah-row__d">{preview}</span> : null}
          <span className="ah-row__s">{status}</span>
        </span>
      </button>
      <span className="ah-row__act">{p.menu}</span>
    </div>
  );
}

export function DocumentsView() {
  const { filteredArtifacts, loading, error, searchQuery, setSearchQuery, deleteArtifact, archiveArtifact, toggleFavorite, createDocument, loadArtifacts } = useArtifacts();
  const { createTab, switchToTab } = useTabs();
  const [filter, setFilter] = useState<Filter>("all");
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const open = (d: Pick<Artifact, "id" | "title">) => switchToTab(createTab("document", d.id, d.title));
  const rename = useCallback(async (id: string, title: string) => {
    await gateway.send("document:update", { documentId: id, title });
    loadArtifacts();
  }, [loadArtifacts]);
  const remove = async (d: Artifact) => {
    // Delete also removes the backing Post and the memories built from it — say so, and offer Archive.
    const ok = confirm(`Delete "${d.title}"?\n\nThis also removes it from Papr Memory, so anything the assistant learned from it goes too.\n\nArchive it instead to keep those memories and just stop it feeding new ones.`);
    if (ok) await deleteArtifact(d.id, "document");
  };
  const create = async () => {
    const doc = await createDocument("Untitled document", "");
    if (doc) open(doc);
  };

  const docs = useMemo(() => filteredArtifacts.filter((a) => a.type === "document"), [filteredArtifacts]);
  const active = docs.filter((d) => d.archived !== true);
  const archivedCount = docs.length - active.length;
  const favCount = active.filter((d) => d.favorite).length;
  const shown = filter === "archived" ? docs.filter((d) => d.archived) : filter === "fav" ? active.filter((d) => d.favorite) : active;
  const searching = searchQuery.trim().length > 0;
  const recent = filter === "all" && !searching && shown.length > RECENT + 2 ? [...shown].sort(newest).slice(0, RECENT) : [];
  const rest = shown.filter((d) => !recent.includes(d)).sort(recent.length ? byName : filter === "all" && !searching ? byName : newest);

  const menuFor = (d: Artifact) => {
    const items: HomeMenuItem[] = [
      { label: "Open", onSelect: () => open(d) },
      { label: "Rename", onSelect: () => setRenamingId(d.id) },
      { label: d.favorite ? "Remove from Favorites" : "Add to Favorites", onSelect: () => void toggleFavorite(d.id, "document") },
      { label: "—", onSelect: () => undefined },
      { label: d.archived ? "Unarchive" : "Archive", onSelect: () => void archiveArtifact(d.id, !d.archived) },
      { label: "Delete", danger: true, onSelect: () => void remove(d) },
    ];
    return <HomeMenu items={items} moveTargets={[]} onMove={() => undefined} />;
  };
  const row = (d: Artifact) => (
    <DocRow key={d.id} doc={d} renaming={renamingId === d.id} onOpen={() => open(d)} onRename={(t) => void rename(d.id, t)} onDone={() => setRenamingId(null)} menu={menuFor(d)} />
  );
  const section = (title: string, list: Artifact[], count?: number) =>
    list.length === 0 ? null : (
      <section className="ah-sec" aria-label={title}>
        <h2 className="ah-sec__h">{title}{count ? <em>{count}</em> : null}</h2>
        <div className="ah-rows">{list.map(row)}</div>
      </section>
    );
  const chip = (f: Filter, label: React.ReactNode) => (
    <button type="button" key={f} className={`ah-chip${filter === f ? " is-on" : ""}`} onClick={() => setFilter(f)}>{label}</button>
  );

  return (
    <div className="documents-view">
      <div className="ah ah--rows dv">
        <div className="ah-head">
          <h1 className="ah-title">Documents</h1>
          <label className="dv-search">
            <HomeIcon name="search" size={14} />
            <input type="search" placeholder="Search documents" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </label>
          <button type="button" className="dv-new" onClick={() => void create()}>
            <HomeIcon name="plus" size={14} />New document
          </button>
        </div>

        <div className="ah-chips" role="toolbar" aria-label="Filter documents">
          {chip("all", "All")}
          {favCount ? chip("fav", <><HomeIcon name="star" size={13} />Favorites</>) : null}
          {archivedCount ? chip("archived", <><HomeIcon name="archive" size={13} />Archived <em className="dv-n">{archivedCount}</em></>) : null}
        </div>

        {loading && docs.length === 0 ? <p className="ah-sec__none">Loading documents…</p> : null}
        {error ? (
          <p className="ah-sec__none">
            {error} <button type="button" className="ah-sec__more" onClick={() => void loadArtifacts()}>Retry</button>
          </p>
        ) : null}
        {!loading && !error && shown.length === 0 ? (
          <div className="dv-empty">
            <p className="dv-empty__t">{searching ? "No matches" : filter === "archived" ? "Nothing archived" : filter === "fav" ? "No favorites yet" : "No documents yet"}</p>
            <p className="dv-empty__s">
              {filter === "archived"
                ? "Archived documents keep the memories they already wrote, and stop writing new ones."
                : searching ? "Try a different word." : "Ask Pen to write one, or start a blank one."}
            </p>
            {filter === "all" && !searching ? (
              <button type="button" className="dv-new" onClick={() => void create()}><HomeIcon name="plus" size={14} />New document</button>
            ) : null}
          </div>
        ) : null}

        {section("Recent", recent)}
        {section(filter === "archived" ? "Archived" : filter === "fav" ? "Favorites" : searching ? "Results" : "All documents", rest, recent.length ? rest.length : undefined)}
      </div>
    </div>
  );
}
