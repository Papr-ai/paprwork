/**
 * Tab - Individual tab component with drag & drop
 */

import React, { useState, useRef } from "react";
import { useTabs } from "../../hooks/useTabs";
import type { Tab as TabType } from "../../stores/tabStore";
import "./Tab.css";

interface TabProps {
  tab: TabType;
  isActive: boolean;
  isMerged: boolean;
  rightTab?: TabType;
  tabIndex: number;
  isStreaming?: boolean;
  hasUnread?: boolean;
  onDragPositionChange?: (
    position: "before" | "after" | "on-top" | null,
    targetElement: HTMLElement | null,
  ) => void;
}

export function Tab({
  tab,
  isActive,
  isMerged,
  rightTab,
  tabIndex,
  isStreaming = false,
  hasUnread = false,
  onDragPositionChange,
}: TabProps) {
  const { switchToTab, closeTab, moveTab, enableSplitView, disableSplitView } =
    useTabs();
  const [isDragging, setIsDragging] = useState(false);
  const [dragPosition, setDragPosition] = useState<
    "before" | "after" | "on-top" | null
  >(null);
  const tabRef = useRef<HTMLDivElement>(null);

  const handleClick = () => {
    // Merged tabs must remain clickable so users can re-focus
    // the parent split view after drag/merge operations.
    switchToTab(tab.id);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // Double-click on merged tab: unmerge it
    if (isMerged && tab.displayMode === "parent") {
      console.log("[Tab] Double-click: Unmerging parent tab", tab.id);
      switchToTab(tab.id, true);
      disableSplitView();
    } else {
      // Switch to tab if not merged
      switchToTab(tab.id);
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(tab.id);
  };

  const handleDragStart = (e: React.DragEvent) => {
    // "copyMove" allows both reordering tabs (move) and dragging to favorites (copy)
    e.dataTransfer.effectAllowed = "copyMove";

    // Tab reorder/merge data (consumed by Tab.handleDrop)
    e.dataTransfer.setData(
      "text/plain",
      JSON.stringify({ tabIndex, tabId: tab.id }),
    );

    // Favorites drop data (consumed by FavoritesList.handleDrop)
    // Include tab metadata so the favorites section can identify the artifact
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({
        id: tab.entityId,
        type: tab.type,
        title: tab.title,
        tabId: tab.id,
      }),
    );

    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    setDragPosition(null);
    onDragPositionChange?.(null, null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (!tabRef.current) return;

    // Calculate position based on mouse location within tab
    const rect = tabRef.current.getBoundingClientRect();
    const mouseX = e.clientX;
    const tabThird = rect.width / 3;

    let position: "before" | "after" | "on-top";

    if (mouseX < rect.left + tabThird) {
      position = "before";
    } else if (mouseX > rect.right - tabThird) {
      position = "after";
    } else {
      position = "on-top";
    }

    if (position !== dragPosition) {
      setDragPosition(position);
      onDragPositionChange?.(position, tabRef.current);
    }
  };

  const handleDragLeave = () => {
    setDragPosition(null);
    onDragPositionChange?.(null, null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();

    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const fromIndex = data.tabIndex;
      const draggedTabId = data.tabId;

      if (dragPosition === "before" || dragPosition === "after") {
        // Reorder tabs
        let toIndex = tabIndex;
        if (dragPosition === "after") {
          toIndex = fromIndex < tabIndex ? tabIndex : tabIndex + 1;
        } else {
          toIndex = fromIndex < tabIndex ? tabIndex - 1 : tabIndex;
        }

        if (fromIndex !== toIndex) {
          moveTab(fromIndex, toIndex);
        }
      } else if (dragPosition === "on-top") {
        // Merge tabs (enable split view)
        enableSplitView(draggedTabId, tab.id);
      }
    } catch (error) {
      console.error("Drop error:", error);
    }

    setDragPosition(null);
    onDragPositionChange?.(null, null);
  };

  // Get icon for tab type
  const getIcon = () => {
    if (tab.icon)
      return <span dangerouslySetInnerHTML={{ __html: tab.icon }} />;

    // Default icons based on type
    const icons: Record<TabType["type"], string> = {
      chat: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      document:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      app: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
      artifacts:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="17" x2="13" y2="17" stroke="currentColor" stroke-width="1.5"/></svg>',
      home: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="9 22 9 12 15 12 15 22" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      meetings:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="1.5"/><line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="1.5"/></svg>',
      jobs: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24" stroke="currentColor" stroke-width="1.5"/></svg>',
      agents:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" stroke="currentColor" stroke-width="1.5"/></svg>',
      skills:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      settings:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };

    return icons[tab.type] ? (
      <span dangerouslySetInnerHTML={{ __html: icons[tab.type] }} />
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    );
  };

  return (
    <div
      ref={tabRef}
      className={`tab ${isActive ? "tab--active" : ""} ${isDragging ? "tab--dragging" : ""} ${dragPosition === "on-top" ? "tab--split-preview" : ""} ${dragPosition ? "tab--drag-over" : ""} ${isMerged ? "tab--merged" : ""} ${tab.isStreaming ? "tab--streaming" : ""} ${tab.hasUnread ? "tab--unread" : ""}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span className="tab__icon">{getIcon()}</span>
      {isMerged && rightTab ? (
        <span className="tab__title tab__title--merged">
          <span className="tab__title-left">{tab.title}</span>
          <span className="tab__title-separator">|</span>
          <span className="tab__title-right">{rightTab.title}</span>
        </span>
      ) : (
        <span className="tab__title">{tab.title}</span>
      )}

      <button
        className="tab__close"
        onClick={handleClose}
        aria-label="Close tab"
      >
        ×
      </button>
    </div>
  );
}
