/**
 * Tab Types - Shared type definitions for tab system
 */

export type TabType =
  | "chat"
  | "document"
  | "app"
  | "home"
  | "meetings"
  | "jobs"
  | "agents"
  | "skills"
  | "settings";

export type DisplayMode = "standalone" | "parent" | "child";

export interface Tab {
  id: string; // "{type}-{id}"
  type: TabType;
  entityId: string; // Chat ID, app ID, etc.
  title: string;
  icon?: string; // SVG string

  // Parent-child hierarchy
  parentTabId: string | null; // If child: reference to parent
  childTabIds: string[]; // If parent: [leftChildId?, rightChildId?] (max 2)
  displayMode: DisplayMode; // 'standalone' | 'parent' | 'child'
  position?: "left" | "right"; // Position within parent (for children only)

  // Status indicators (for chat tabs)
  isStreaming?: boolean; // Blue pulsing dot
  hasUnread?: boolean; // Green static dot (when streaming finished in bg tab)

  metadata?: Record<string, unknown>;
}

export interface TabDragData {
  tabId: string;
  tabIndex: number;
}

export type DragPosition = "before" | "after" | "on-top" | null;
