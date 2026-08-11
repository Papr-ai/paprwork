/**
 * Tab Types - Shared type definitions for tab system
 */

export type TabType =
  | "chat"
  | "document"
  | "app"
  | "apps"
  | "documents"
  | "artifacts"
  | "views"
  | "view"
  | "home"
  | "meetings"
  | "jobs"
  | "agents"
  | "skills"
  | "memory"
  | "settings"
  | "getting-started"
  | "chatgpt-conv-history";

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
  isStreaming?: boolean; // Blue pulsing dot — agent actively working
  hasUnread?: boolean; // Green static dot — chat finished with new response (background tab)
  pendingRefresh?: boolean; // Soft periwinkle dot — split-view updated, chat not fully final yet

  // Favorites
  isFavorite?: boolean; // Whether this tab is favorited

  metadata?: Record<string, unknown>;
}

export interface TabDragData {
  tabId: string;
  tabIndex: number;
}

export type DragPosition = "before" | "after" | "on-top" | null;
