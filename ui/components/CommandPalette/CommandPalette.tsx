/**
 * CommandPalette - Cmd+K power user interface
 * Provides quick access to all internal features (Artifacts, Views, Meetings, Agents, Jobs, Skills)
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTabs } from "../../hooks/useTabs";
import { useArtifactsStore } from "../../stores/artifactsStore";
import { useArtifacts } from "../../hooks/useArtifacts";
import type { TabType } from "../../types/tabs";
import "./CommandPalette.css";

// Platform-aware modifier key detection
const isMac = navigator.platform.toUpperCase().includes("MAC");
const modKey = isMac ? "\u2318" : "Ctrl+";
const modName = isMac ? "Cmd" : "Ctrl";

interface CommandItem {
  id: string;
  label: string;
  description: string;
  tabType: TabType;
  entityId: string;
  shortcut?: string;
  icon: React.ReactNode;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

const COMMANDS: CommandItem[] = [
  {
    id: "artifacts",
    label: "Documents & Artifacts",
    description: "Browse all documents and artifacts",
    tabType: "artifacts",
    entityId: "artifacts",
    shortcut: `${modKey}D`,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "views",
    label: "Views",
    description: "Data views and tables",
    tabType: "views",
    entityId: "views",
    shortcut: `${modKey}Shift+V`,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="7" height="7" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="3" width="7" height="7" stroke="currentColor" strokeWidth="1.5" />
        <line x1="3" y1="14" x2="10" y2="14" stroke="currentColor" strokeWidth="1.5" />
        <line x1="14" y1="14" x2="21" y2="14" stroke="currentColor" strokeWidth="1.5" />
        <line x1="3" y1="18" x2="10" y2="18" stroke="currentColor" strokeWidth="1.5" />
        <line x1="14" y1="18" x2="21" y2="18" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "agents",
    label: "Agents",
    description: "AI agents and sub-agents",
    tabType: "agents",
    entityId: "agents",
    shortcut: `${modKey}Shift+A`,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "jobs",
    label: "Jobs",
    description: "Scheduled jobs and automation",
    tabType: "jobs",
    entityId: "jobs",
    shortcut: `${modKey}J`,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "skills",
    label: "Skills",
    description: "Skills marketplace and management",
    tabType: "skills",
    entityId: "skills",
    shortcut: `${modKey}Shift+S`,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    description: "App preferences and configuration",
    tabType: "settings",
    entityId: "settings",
    shortcut: `${modKey},`,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
];

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { createTab, switchToTab } = useTabs();
  const artifacts = useArtifactsStore((s) => s.artifacts);
  const { loadArtifacts } = useArtifacts();

  // Load apps when palette opens
  useEffect(() => {
    if (isOpen) loadArtifacts();
  }, [isOpen, loadArtifacts]);

  // Build dynamic app commands from artifacts store
  const appCommands: CommandItem[] = useMemo(
    () =>
      artifacts
        .filter((a) => a.type === "app")
        .map((app) => ({
          id: `app-${app.id}`,
          label: app.title || "Untitled App",
          description: "Open app",
          tabType: "app" as TabType,
          entityId: app.id,
          icon: (
            <span className="cmd-palette__app-orb">
              {app.icon ? (
                <span className="cmd-palette__app-orb-icon" dangerouslySetInnerHTML={{ __html: app.icon }} />
              ) : (
                <svg className="cmd-palette__app-orb-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <defs>
                    <linearGradient id="cmd-papr-blue-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#00D4FF" />
                      <stop offset="100%" stopColor="#0066FF" />
                    </linearGradient>
                  </defs>
                  <rect x="3" y="3" width="7" height="7" rx="2" stroke="url(#cmd-papr-blue-gradient)" strokeWidth="1.5"/>
                  <rect x="14" y="3" width="7" height="7" rx="2" stroke="url(#cmd-papr-blue-gradient)" strokeWidth="1.5"/>
                  <rect x="3" y="14" width="7" height="7" rx="2" stroke="url(#cmd-papr-blue-gradient)" strokeWidth="1.5"/>
                  <rect x="14" y="14" width="7" height="7" rx="2" stroke="url(#cmd-papr-blue-gradient)" strokeWidth="1.5"/>
                </svg>
              )}
            </span>
          ),
        })),
    [artifacts],
  );

  // Filter commands + apps based on query
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filteredCommands = q
      ? COMMANDS.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(q) ||
            cmd.description.toLowerCase().includes(q),
        )
      : COMMANDS;
    const filteredApps = q
      ? appCommands.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(q) ||
            cmd.description.toLowerCase().includes(q),
        )
      : appCommands;
    return { commands: filteredCommands, apps: filteredApps };
  }, [query, appCommands]);

  // Flat list for keyboard navigation
  const allItems = useMemo(
    () => [...filtered.commands, ...filtered.apps],
    [filtered],
  );

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Keep selected index in bounds
  useEffect(() => {
    if (selectedIndex >= allItems.length) {
      setSelectedIndex(Math.max(0, allItems.length - 1));
    }
  }, [allItems.length, selectedIndex]);

  const executeCommand = useCallback(
    (cmd: CommandItem) => {
      const tabId = createTab(cmd.tabType, cmd.entityId, cmd.label);
      switchToTab(tabId);
      onClose();
    },
    [createTab, switchToTab, onClose],
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
            executeCommand(allItems[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [allItems, selectedIndex, executeCommand, onClose],
  );

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector(`[data-cmd-index="${selectedIndex}"]`) as HTMLElement;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="cmd-palette__overlay" onClick={onClose}>
      <div
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="cmd-palette__input-wrapper">
          <svg
            className="cmd-palette__search-icon"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.5" />
            <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="cmd-palette__input"
            type="text"
            placeholder="Search commands..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <kbd className="cmd-palette__esc">esc</kbd>
        </div>

        {/* Commands list */}
        <div className="cmd-palette__list" ref={listRef}>
          {allItems.length === 0 && (
            <div className="cmd-palette__empty">No results found</div>
          )}
          {filtered.commands.map((cmd) => {
            const flatIndex = allItems.indexOf(cmd);
            return (
              <button
                key={cmd.id}
                data-cmd-index={flatIndex}
                className={`cmd-palette__item ${flatIndex === selectedIndex ? "cmd-palette__item--selected" : ""}`}
                onClick={() => executeCommand(cmd)}
                onMouseEnter={() => setSelectedIndex(flatIndex)}
              >
                <span className="cmd-palette__item-icon">{cmd.icon}</span>
                <div className="cmd-palette__item-text">
                  <span className="cmd-palette__item-label">{cmd.label}</span>
                  <span className="cmd-palette__item-desc">
                    {cmd.description}
                  </span>
                </div>
                {cmd.shortcut && (
                  <kbd className="cmd-palette__shortcut">{cmd.shortcut}</kbd>
                )}
              </button>
            );
          })}
          {filtered.apps.length > 0 && (
            <div className="cmd-palette__section-label">Apps</div>
          )}
          {filtered.apps.map((cmd) => {
            const flatIndex = allItems.indexOf(cmd);
            return (
              <button
                key={cmd.id}
                data-cmd-index={flatIndex}
                className={`cmd-palette__item ${flatIndex === selectedIndex ? "cmd-palette__item--selected" : ""}`}
                onClick={() => executeCommand(cmd)}
                onMouseEnter={() => setSelectedIndex(flatIndex)}
              >
                <span className="cmd-palette__item-icon">{cmd.icon}</span>
                <div className="cmd-palette__item-text">
                  <span className="cmd-palette__item-label">{cmd.label}</span>
                  <span className="cmd-palette__item-desc">
                    {cmd.description}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
