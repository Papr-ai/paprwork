/**
 * CommandPalette (⌘K). One job: get to the thing you want.
 *
 * Empty query: Continue (latest chat, app, doc) · Pinned · Go to.
 * Typing:      Results (chats, apps, docs by title) · Go to.
 * Opened from Focus or Memory it starts scoped to memory (a removable chip).
 * ↵ opens; ⌘↵ opens an app or doc beside the chat on screen.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTabs } from "../../hooks/useTabs";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useChat } from "../../hooks/useChat";
import { useTabStore } from "../../stores/tabStore";
import type { TabType } from "../../types/tabs";
import { switchToFocusTab, switchToMemoryTab } from "../../lib/ensureDefaultChatTab";
import { requestMemoryEntity } from "../../lib/memoryNav";
import { wikiTypeMeta } from "../../types/wiki";
import { scopeForActiveTab, useScopedMemorySearch, type PaletteScope } from "./usePaletteScope";
import { usePaletteEntities, type PaletteEntity } from "./usePaletteEntities";
import { COMMANDS, KIND_ICON, KIND_LABEL, isMac, type CommandItem } from "./paletteCommands";
import { renderAppIcon } from "../../utils/renderAppIcon";
import "./CommandPalette.css";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Section {
  title: string;
  items: CommandItem[];
}

const MAX_PINNED = 6;

/**
 * The app's own icon (the same one the Apps grid shows), falling back to the kind glyph.
 * Docs and chats have no per-item icon, so they always use the kind glyph.
 */
function entityIcon(e: PaletteEntity): React.ReactNode {
  if (e.kind !== "app" || !e.icon?.trim()) return KIND_ICON[e.kind];
  return renderAppIcon(e.icon, { size: 30, className: "cmd-palette__app-icon" });
}

function entityItem(e: PaletteEntity, section: string): CommandItem {
  return {
    id: `${section}:${e.key}`,
    label: e.title,
    description: "",
    tabType: e.kind as TabType,
    entityId: e.id,
    icon: entityIcon(e),
    entity: e,
    kindLabel: KIND_LABEL[e.kind],
    live: e.live,
  };
}

/** The chat on screen, in either pane, if there is one. */
function activeChatTabId(): string | null {
  const { tabs, activeLeftTab, activeRightTab, activeTabId } = useTabStore.getState();
  for (const id of [activeLeftTab, activeRightTab, activeTabId]) {
    const tab = id ? tabs.find((t) => t.id === id) : undefined;
    if (tab?.type === "chat") return tab.id;
  }
  return null;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scope, setScope] = useState<PaletteScope | null>(null);
  const memory = useScopedMemorySearch(scope, query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { createTab, switchToTab } = useTabs();
  const { loadArtifacts } = useArtifacts();
  const { loadMessages } = useChat();
  const { continueItems, pinned, search } = usePaletteEntities();

  useEffect(() => {
    if (isOpen) void loadArtifacts();
  }, [isOpen, loadArtifacts]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    const memoryItems: CommandItem[] = memory.results.map((node) => {
      const meta = wikiTypeMeta(node.type);
      return {
        id: `wiki-${node.type}-${node.id}`,
        label: node.label,
        description: meta.label,
        tabType: "memory" as TabType,
        entityId: "wiki",
        node,
        kindLabel: meta.label,
        icon: (
          <span className="cmd-palette__wiki-glyph" style={{ color: meta.color }}>
            {meta.glyph}
          </span>
        ),
      };
    });
    const goTo = q
      ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      : COMMANDS;

    const out: Section[] = [];
    if (scope) out.push({ title: `In ${scope.label}`, items: memoryItems });
    if (q) {
      out.push({ title: "Results", items: search(q).map((e) => entityItem(e, "result")) });
    } else {
      out.push({ title: "Continue", items: continueItems.map((e) => entityItem(e, "continue")) });
      // Something you just touched and also pinned shows once, under Continue.
      const shown = new Set(continueItems.map((e) => e.key));
      const pins = pinned.filter((e) => !shown.has(e.key)).slice(0, MAX_PINNED);
      out.push({ title: "Pinned", items: pins.map((e) => entityItem(e, "pinned")) });
    }
    out.push({ title: "Go to", items: goTo });
    return out.filter((s) => s.items.length > 0);
  }, [query, memory.results, scope, search, continueItems, pinned]);

  const allItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setScope(scopeForActiveTab());
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Keep selected index in bounds
  useEffect(() => {
    if (selectedIndex >= allItems.length) {
      setSelectedIndex(Math.max(0, allItems.length - 1));
    }
  }, [allItems.length, selectedIndex]);

  const openEntity = useCallback(
    (e: PaletteEntity, beside: boolean) => {
      if (e.kind === "chat") {
        void loadMessages(e.id);
        switchToTab(e.tabId ?? createTab("chat", e.id, e.title));
        return;
      }
      // Read the chat on screen before createTab, which can make the new tab active.
      const chatTabId = beside ? activeChatTabId() : null;
      const tabId = createTab(e.kind, e.id, e.title, e.icon ? { icon: e.icon } : {});
      if (chatTabId) useTabStore.getState().createArtifactFromChat(chatTabId, tabId);
      else switchToTab(tabId);
    },
    [createTab, switchToTab, loadMessages],
  );

  const executeCommand = useCallback(
    (cmd: CommandItem, beside = false) => {
      if (cmd.entity) {
        openEntity(cmd.entity, beside);
      } else if (cmd.node) {
        switchToMemoryTab();
        requestMemoryEntity(cmd.node);
      } else if (cmd.tabType === "focus") {
        switchToFocusTab();
      } else if (cmd.tabType === "memory") {
        switchToMemoryTab();
      } else {
        switchToTab(createTab(cmd.tabType, cmd.entityId, cmd.label));
      }
      onClose();
    },
    [openEntity, createTab, switchToTab, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, allItems.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (allItems[selectedIndex]) {
            executeCommand(allItems[selectedIndex], e.metaKey || e.ctrlKey);
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation(); // don't also back out of the page underneath
          onClose();
          break;
        case "Backspace":
          if (scope && !query) {
            e.preventDefault();
            setScope(null);
          }
          break;
      }
    },
    [allItems, selectedIndex, executeCommand, onClose, scope, query],
  );

  // Scroll selected item into view
  useEffect(() => {
    const item = listRef.current?.querySelector(`[data-cmd-index="${selectedIndex}"]`) as HTMLElement | null;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen) return null;

  let flatIndex = -1;
  return (
    <div className="cmd-palette__overlay" onClick={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="cmd-palette__input-wrapper">
          <svg className="cmd-palette__search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.5" />
            <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {scope && (
            <span className="cmd-palette__scope">
              {scope.label}
              <button
                type="button"
                className="cmd-palette__scope-clear"
                aria-label={`Search everywhere instead of ${scope.label}`}
                onClick={() => {
                  setScope(null);
                  inputRef.current?.focus();
                }}
              >
                ×
              </button>
            </span>
          )}
          <input
            ref={inputRef}
            className="cmd-palette__input"
            type="text"
            aria-label="Search"
            placeholder={scope ? "Search goals, people, projects…" : "Search chats, apps, docs, or jump to…"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <kbd className="cmd-palette__esc">esc</kbd>
        </div>

        <div className="cmd-palette__list" ref={listRef}>
          {allItems.length === 0 && (
            <div className="cmd-palette__empty">
              {memory.loading ? "Searching…" : `No match for “${query.trim()}”`}
            </div>
          )}
          {sections.map((section) => (
            <React.Fragment key={section.title}>
              <div className="cmd-palette__section-label">{section.title}</div>
              {section.items.map((cmd) => {
                flatIndex += 1;
                const index = flatIndex;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    data-cmd-index={index}
                    className={`cmd-palette__item ${index === selectedIndex ? "cmd-palette__item--selected" : ""}`}
                    onClick={(e) => executeCommand(cmd, e.metaKey || e.ctrlKey)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className={`cmd-palette__item-icon${cmd.entity?.kind === "app" && cmd.entity.icon ? " cmd-palette__item-icon--app" : ""}`}>
                      {cmd.icon}
                    </span>
                    <span className="cmd-palette__item-label">{cmd.label}</span>
                    {cmd.live && <i className="cmd-palette__live" title="Pen is working" />}
                    {cmd.shortcut ? (
                      <kbd className="cmd-palette__shortcut">{cmd.shortcut}</kbd>
                    ) : cmd.kindLabel ? (
                      <span className="cmd-palette__kind">{cmd.kindLabel}</span>
                    ) : null}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        <div className="cmd-palette__foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>{isMac ? "⌘" : "Ctrl"}</kbd><kbd>↵</kbd> open beside chat</span>
        </div>
      </div>
    </div>
  );
}
