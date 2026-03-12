/**
 * ContentArea - Main content area with split-view support
 * Reference: Paprwork v1 split view implementation
 */

import React, { useRef, useCallback, useEffect } from "react";
import { useTabs } from "../../hooks/useTabs";
import { ChatContainer } from "../Chat/ChatContainer";
import { ArtifactsView } from "../Artifacts/ArtifactsView";
import { AppsView } from "../Apps/AppsView";
import { DocumentsView } from "../Documents/DocumentsView";
import { DocumentView } from "../Documents/DocumentView";
import { SettingsView } from "../Settings/SettingsView";
import { JobsView } from "../Jobs/JobsView";
import { MiniAppView } from "../Apps/MiniAppView";
import { SkillsView } from "../Skills/SkillsView";
import { AgentsView } from "../Agents/AgentsViewCards";
import { MeetingsView } from "../Meetings/MeetingsView";
import { ViewsView } from "../Views/ViewsView";
import { TableView } from "../Views/TableView";
import { ChatGPTConvHistoryView } from "../ChatGPT/ChatGPTConvHistoryView";
import "./ContentArea.css";

export function ContentArea() {
  const {
    activeTabId,
    activeLeftTab,
    activeRightTab,
    isSplitView,
    splitRatio,
    getTab,
    setSplitRatio,
    getSplitRatio,
  } = useTabs();

  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startRatioRef = useRef(0);
  const containerWidthRef = useRef(0);

  // Get the actual active tab and its children (if parent)
  const activeTab = getTab(activeTabId || "");
  const isParentTab = activeTab?.displayMode === "parent";

  // Get tab-specific split ratio (or default to global)
  const currentSplitRatio = getSplitRatio(activeTabId);

  // Determine what to render in each pane
  let leftPaneTabId: string | null = activeLeftTab;
  let rightPaneTabId: string | null = activeRightTab;
  let showSplitView = isSplitView;

  if (isParentTab && activeTab.childTabIds.length > 0) {
    showSplitView = true;
    if (activeTab.childTabIds.length === 1) {
      // 1 child: Show parent on left, child on right
      leftPaneTabId = activeTabId;
      rightPaneTabId = activeTab.childTabIds[0];
    } else {
      // 2 children: Show first child on left, second child on right
      leftPaneTabId = activeTab.childTabIds[0];
      rightPaneTabId = activeTab.childTabIds[1];
    }
  }

  // Handle split view resize with stable event handlers
  const handleMouseMove = useCallback(
    (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;

      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - startXRef.current;
      const deltaRatio = deltaX / containerWidthRef.current;
      const newRatio = startRatioRef.current + deltaRatio;
      const clampedRatio = Math.max(0.2, Math.min(0.8, newRatio));
      setSplitRatio(clampedRatio);
    },
    [setSplitRatio],
  );

  const handleMouseUp = useCallback(() => {
    if (!isDraggingRef.current) return;

    isDraggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.classList.remove("resizing");

    // Remove iframe blocker overlay
    const overlay = document.getElementById("resize-overlay");
    if (overlay) {
      overlay.remove();
    }
  }, []);

  // Clean up event listeners on unmount or when handlers change
  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Clean up any lingering drag state
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.body.classList.remove("resizing");

        // Remove iframe blocker overlay if it exists
        const overlay = document.getElementById("resize-overlay");
        if (overlay) {
          overlay.remove();
        }
      }
    };
  }, [handleMouseMove, handleMouseUp]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Check showSplitView (local state) not isSplitView (global state)
    // This fixes resize for merged tabs (parent mode)
    if (!showSplitView || !containerRef.current) return;

    e.preventDefault();
    e.stopPropagation();

    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    startRatioRef.current = currentSplitRatio; // Use tab-specific ratio
    containerWidthRef.current = containerRef.current.offsetWidth;

    // Prevent text selection during drag
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.body.classList.add("resizing");

    // Create overlay to block iframe pointer events during resize
    // This prevents iframes from capturing mousemove/mouseup events
    const overlay = document.createElement("div");
    overlay.id = "resize-overlay";
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.zIndex = "9999";
    overlay.style.cursor = "col-resize";
    overlay.style.background = "transparent";
    document.body.appendChild(overlay);
  };

  // Render view based on tab type
  const renderView = (tabId: string | null) => {
    if (!tabId)
      return <div className="content-area__empty">No tab selected</div>;

    const tab = getTab(tabId);
    if (!tab) return <div className="content-area__empty">Tab not found</div>;

    switch (tab.type) {
      case "chat":
        return <ChatContainer chatId={tab.entityId} />;
      case "document":
        return <DocumentView documentId={tab.entityId} />;
      case "documents":
        return <DocumentsView />;
      case "apps":
        return <AppsView />;
      case "artifacts":
        return <ArtifactsView />;
      case "views":
        return <ViewsView />;
      case "view":
        return <TableView entityId={tab.entityId} />;
      case "app":
        return <MiniAppView appId={tab.entityId} />;
      case "home":
        return (
          <div className="content-area__placeholder">
            Agent Lounge (Coming Soon)
          </div>
        );
      case "meetings":
        return <MeetingsView />;
      case "jobs":
        return <JobsView />;
      case "agents":
        return <AgentsView />;
      case "skills":
        return <SkillsView />;
      case "settings":
        return <SettingsView />;
      case "chatgpt-conv-history":
        return <ChatGPTConvHistoryView />;
      default:
        return <div className="content-area__empty">Unknown tab type</div>;
    }
  };

  if (!showSplitView) {
    return (
      <div className="content-area">
        <div className="content-pane content-pane--full">
          {renderView(leftPaneTabId)}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="content-area content-area--split"
      style={{ "--split-ratio": currentSplitRatio } as React.CSSProperties}
    >
      <div className="content-pane content-pane--left">
        {renderView(leftPaneTabId)}
      </div>
      <div
        className="content-area__resize-handle"
        onMouseDown={handleMouseDown}
      >
        <div className="content-area__resize-line" />
      </div>
      <div className="content-pane content-pane--right">
        {renderView(rightPaneTabId)}
      </div>
    </div>
  );
}
