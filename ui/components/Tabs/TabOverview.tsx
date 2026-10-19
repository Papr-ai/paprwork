/**
 * TabOverview — "show all tabs" sheet for when the strip gets crowded.
 * Opens from a pinch on the tab bar (trackpad pinch = ctrl+wheel), ⌘⇧\, or the
 * grid button; pinch out or Esc closes. Cards open, close, drag to reorder,
 * drop onto each other to merge (same split view as the strip), and unmerge.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTabStore, type Tab } from "../../stores/tabStore";
import { useChatStore } from "../../stores/chatStore";
import { TabGlyph } from "./Tab";
import "./TabOverview.css";

type DropPos = "before" | "after" | "merge";

const TYPE_LABEL: Record<string, string> = {
  chat: "Chat",
  app: "App",
  document: "Document",
  documents: "Documents",
  memory: "Memory",
  focus: "Focus",
};

function typeLabel(t: Tab): string {
  return TYPE_LABEL[t.type] ?? t.type.charAt(0).toUpperCase() + t.type.slice(1);
}

export function TabOverview({ onClose }: { onClose: () => void }) {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const chats = useChatStore((s) => s.chats);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  // "Split with…" pick mode: choose the source, then search/click any row to merge.
  // Works across a long list where dragging row 35 onto row 1 is painful.
  const [pickId, setPickId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const escRef = useRef<() => void>(onClose);
  escRef.current = pickId ? () => setPickId(null) : onClose;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const byId = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const kids = (t: Tab) =>
    t.childTabIds.map((id) => byId.get(id)).filter((c): c is Tab => Boolean(c));
  const top = tabs.filter((t) => t.displayMode !== "child");
  const q = query.trim().toLowerCase();
  const shown = (q
    ? top.filter((t) => [t, ...kids(t)].some((x) => x.title.toLowerCase().includes(q)))
    : top
  ).filter((t) => t.id !== pickId);
  const pickTab = pickId ? byId.get(pickId) : undefined;

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      escRef.current();
    };
    // Pinch out (ctrl+wheel up) closes, mirroring the pinch in that opened it.
    let acc = 0;
    let timer: number | undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      acc += e.deltaY;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (acc = 0), 250);
      if (acc < -24) closeRef.current();
    };
    const el = rootRef.current;
    window.addEventListener("keydown", onKey);
    el?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      el?.removeEventListener("wheel", onWheel);
      window.clearTimeout(timer);
    };
  }, []);

  const store = () => useTabStore.getState();
  const open = (id: string) => {
    store().switchToTab(id);
    onClose();
  };
  const startPick = (id: string) => {
    setPickId(id);
    setQuery("");
    inputRef.current?.focus();
  };
  const pickMerge = (targetId: string) => {
    if (pickId && pickId !== targetId) store().enableSplitView(pickId, targetId);
    setPickId(null);
    setQuery("");
  };
  // Native drag doesn't reliably auto-scroll; nudge the list near its edges.
  const autoScroll = (e: React.DragEvent) => {
    const el = listRef.current;
    if (!el || !dragId) return;
    const r = el.getBoundingClientRect();
    if (e.clientY < r.top + 40) el.scrollTop -= 14;
    else if (e.clientY > r.bottom - 40) el.scrollTop += 14;
  };
  const unmerge = (t: Tab) => t.childTabIds.forEach((id) => store().promoteToStandalone(id));
  const statusOf = (t: Tab) => {
    const c = t.type === "chat" ? chats.find((x) => x.id === t.entityId) : undefined;
    return c?.isStreaming ? "streaming" : c?.hasUnread ? "unread" : null;
  };

  const posFor = (e: React.DragEvent<HTMLElement>): DropPos => {
    const r = e.currentTarget.getBoundingClientRect();
    const edge = r.height * 0.3;
    // A split tab can't be nested inside another split — only reorder it.
    const dragged = dragId ? byId.get(dragId) : undefined;
    if (dragged?.childTabIds.length) return e.clientY < r.top + r.height / 2 ? "before" : "after";
    if (e.clientY < r.top + edge) return "before";
    if (e.clientY > r.bottom - edge) return "after";
    return "merge";
  };

  const dropOn = (target: Tab) => {
    const pos = drop?.id === target.id ? drop.pos : null;
    const from = dragId;
    setDrop(null);
    setDragId(null);
    if (!pos || !from || from === target.id) return;
    if (pos === "merge") {
      store().enableSplitView(from, target.id);
      return;
    }
    // Same index math as the tab strip (indices into the full tabs array).
    const all = store().tabs;
    const fromIndex = all.findIndex((t) => t.id === from);
    const to = all.findIndex((t) => t.id === target.id);
    if (fromIndex < 0 || to < 0) return;
    const toIndex =
      pos === "after" ? (fromIndex < to ? to : to + 1) : fromIndex < to ? to - 1 : to;
    if (fromIndex !== toIndex) store().moveTab(fromIndex, toIndex);
  };

  return createPortal(
    <div
      ref={rootRef}
      className="tab-ov"
      role="dialog"
      aria-modal="true"
      aria-label="All tabs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tab-ov__panel">
        <header className="tab-ov__head">
          <h2 className="tab-ov__title">
            Tabs <span>{top.length}</span>
          </h2>
          <input
            ref={inputRef}
            className="tab-ov__search"
            placeholder={pickTab ? "Search for the tab to split with…" : "Search titles…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) (pickId ? pickMerge : open)(shown[0].id);
            }}
          />
        </header>
        {pickTab ? (
          <div className="tab-ov__pick">
            <span>
              Split <b>{pickTab.title}</b> with…
            </span>
            <button type="button" className="tab-ov__pick-cancel" onClick={() => setPickId(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <span className="tab-ov__hint">Drag to reorder · hover a tab and press ⊟ to split it with any other</span>
        )}

        {shown.length === 0 ? <p className="tab-ov__none">No tabs match.</p> : null}

        <div className={`tab-ov__list${pickTab ? " is-picking" : ""}`} ref={listRef} onDragOver={autoScroll}>
          {shown.map((t) => {
            const children = kids(t);
            const status = statusOf(t);
            const dropHere = drop?.id === t.id ? drop.pos : null;
            const cls = [
              "tab-ov__row",
              t.id === activeTabId ? "is-active" : "",
              dragId === t.id ? "is-dragging" : "",
              dropHere ? `is-drop-${dropHere}` : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={t.id}
                className={cls}
                role="button"
                tabIndex={0}
                draggable={!pickId}
                onClick={() => (pickId ? pickMerge(t.id) : open(t.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (pickId ? pickMerge : open)(t.id);
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("application/x-papr-tab-overview", t.id);
                  setDragId(t.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDrop(null);
                }}
                onDragOver={(e) => {
                  if (!dragId || dragId === t.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const pos = posFor(e);
                  if (drop?.id !== t.id || drop.pos !== pos) setDrop({ id: t.id, pos });
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                  setDrop((d) => (d?.id === t.id ? null : d));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(t);
                }}
              >
                <span className="tab-ov__icon">
                  <TabGlyph tab={t} />
                </span>
                <span className="tab-ov__main">
                  <span className="tab-ov__name">{t.title}</span>
                  {children.map((c) => (
                    <span key={c.id} className="tab-ov__child">
                      <span className="tab-ov__icon tab-ov__icon--sm">
                        <TabGlyph tab={c} />
                      </span>
                      <span className="tab-ov__child-title">{c.title}</span>
                    </span>
                  ))}
                </span>
                {status ? <i className={`tab-ov__dot tab-ov__dot--${status}`} /> : null}
                <span className="tab-ov__type">{children.length ? "Split" : typeLabel(t)}</span>
                <span className="tab-ov__acts">
                    {!children.length && !pickId ? (
                      <button
                        type="button"
                        className="tab-ov__act"
                        aria-label="Split with another tab"
                        title="Split with…"
                        onClick={(e) => {
                          e.stopPropagation();
                          startPick(t.id);
                        }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path
                            d="M2.5 3.5h11v9h-11zM8 3.5v9"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    ) : null}
                    {children.length ? (
                      <button
                        type="button"
                        className="tab-ov__act"
                        aria-label="Unmerge"
                        title="Unmerge"
                        onClick={(e) => {
                          e.stopPropagation();
                          unmerge(t);
                        }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path
                            d="M2.5 3.5h4v9h-4zM9.5 3.5h4v9h-4z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="tab-ov__act"
                      aria-label="Close tab"
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation();
                        store().closeTab(t.id);
                      }}
                    >
                      ×
                    </button>
                  </span>
                {dropHere === "merge" ? <span className="tab-ov__merge-badge">Merge</span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
