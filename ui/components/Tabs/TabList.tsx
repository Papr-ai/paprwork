/**
 * TabList — Chrome-style "search tabs" dropdown. One row per open tab, click to
 * jump, × to close. "Rearrange tabs" hands off to the card overview (drag/merge).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTabStore, type Tab } from "../../stores/tabStore";
import { useChatStore } from "../../stores/chatStore";
import { TabGlyph } from "./Tab";
import "./TabList.css";

interface Props {
  onClose: () => void;
  onRearrange: () => void;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  /** Off for hover peeks so the composer keeps focus. */
  autoFocusSearch?: boolean;
  /** Typing pins a hover peek open. */
  onInteract?: () => void;
}

const TYPE_LABEL: Record<string, string> = { chat: "Chat", app: "App", document: "Document", documents: "Documents", memory: "Memory", focus: "Focus" };

export function TabList({ onClose, onRearrange, dropdownRef, autoFocusSearch = true, onInteract }: Props) {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const chats = useChatStore((s) => s.chats);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);

  // A merged tab appears as one row naming both halves, like the strip does.
  const rows = tabs
    .filter((t) => t.displayMode !== "child")
    .map((t) => {
      const kids = t.childTabIds.map((id) => byId.get(id)).filter((c): c is Tab => Boolean(c));
      const title = [t, ...kids].map((x) => x.title).join("  |  ");
      return { tab: t, title, merged: kids.length > 0 };
    });
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;

  useEffect(() => {
    if (autoFocusSearch) inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, autoFocusSearch]);

  const open = (id: string) => {
    useTabStore.getState().switchToTab(id);
    onClose();
  };
  const statusOf = (t: Tab) => {
    const c = t.type === "chat" ? chats.find((x) => x.id === t.entityId) : undefined;
    return c?.isStreaming ? "streaming" : c?.hasUnread ? "unread" : null;
  };

  return (
    <div className="tab-list rail-scope" ref={dropdownRef} role="dialog" aria-label="Open tabs">
      <div className="tab-list__search-wrap">
        <input
          ref={inputRef}
          className="tab-list__search"
          placeholder="Search titles…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onInteract?.();
          }}
          onFocus={onInteract}
          onKeyDown={(e) => e.key === "Enter" && shown[0] && open(shown[0].tab.id)}
        />
      </div>
      <div className="tab-list__label">Open tabs</div>
      <div className="tab-list__rows">
        {shown.length === 0 ? <p className="tab-list__none">No tabs match.</p> : null}
        {shown.map(({ tab: t, title, merged }) => {
          const status = statusOf(t);
          return (
            <div
              key={t.id}
              className={`tab-list__row${t.id === activeTabId ? " is-active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => open(t.id)}
              onKeyDown={(e) => e.key === "Enter" && open(t.id)}
            >
              <span className="tab-list__icon"><TabGlyph tab={t} /></span>
              <span className="tab-list__text">
                <span className="tab-list__title">{title}</span>
                <span className="tab-list__sub">{merged ? "Split view" : (TYPE_LABEL[t.type] ?? t.type)}</span>
              </span>
              {status ? <i className={`tab-list__dot tab-list__dot--${status}`} /> : null}
              <button
                type="button"
                className="tab-list__x"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  useTabStore.getState().closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-list__foot" onClick={onRearrange}>
        Rearrange tabs…
      </button>
    </div>
  );
}
