/**
 * ⌘K data: the "Go to" pages, kind icons/labels, and the row model shared by every section.
 */
import React from "react";
import type { TabType } from "../../types/tabs";
import type { WikiNode } from "../../types/wiki";
import { MemoryIcon } from "../Memory/MemoryIcon";
import { AgentGlyph } from "../Agent/AgentGlyph";
import type { EntityKind, PaletteEntity } from "./usePaletteEntities";

// Platform-aware modifier key detection
export const isMac = navigator.platform.toUpperCase().includes("MAC");
export const modKey = isMac ? "\u2318" : "Ctrl+";
export const modName = isMac ? "Cmd" : "Ctrl";

export interface CommandItem {
  id: string;
  label: string;
  description: string;
  tabType: TabType;
  entityId: string;
  shortcut?: string;
  icon: React.ReactNode;
  /** Memory result — opens the entity on the Memory page. */
  node?: WikiNode;
  /** Chat, app, or doc — Continue / Pinned / Results. */
  entity?: PaletteEntity;
  /** Right-hand label when there is no shortcut: Chat, App, Doc, Person… */
  kindLabel?: string;
  /** Pen is working in this chat right now. */
  live?: boolean;
}

export const COMMANDS: CommandItem[] = [
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
    id: "focus",
    label: "Focus",
    description: "Today's brief, your three, and tasks",
    tabType: "focus",
    entityId: "focus",
    icon: <AgentGlyph size={20} />,
  },
  {
    id: "memory",
    label: "Memory",
    description: "People, projects, and context your agent knows",
    tabType: "memory",
    entityId: "wiki",
    shortcut: `${modKey}Shift+M`,
    icon: <MemoryIcon size={20} />,
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

const stroke = { stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const KIND_ICON: Record<EntityKind, React.ReactNode> = {
  chat: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path d="M20 12a8 8 0 01-11.6 7.1L4 20l1-4.1A8 8 0 1120 12z" {...stroke} />
    </svg>
  ),
  app: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" {...stroke} />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" {...stroke} />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" {...stroke} />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" {...stroke} />
    </svg>
  ),
  document: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" {...stroke} />
      <path d="M14 3v5h5M9 13h6M9 17h4" {...stroke} />
    </svg>
  ),
};

export const KIND_LABEL: Record<EntityKind, string> = { chat: "Chat", app: "App", document: "Doc" };
