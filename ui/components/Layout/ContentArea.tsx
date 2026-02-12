/**
 * ContentArea - Main content area with split-view support
 * Reference: Paprwork v1 split view implementation
 */

import React, { useRef } from "react";
import { useTabs } from "../../hooks/useTabs";
import { ChatContainer } from "../Chat/ChatContainer";
import { ArtifactsView } from "../Artifacts/ArtifactsView";
import { SettingsView } from "../Settings/SettingsView";
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
  } = useTabs();

  const containerRef = useRef<HTMLDivElement>(null);

  // Get the actual active tab and its children (if parent)
  const activeTab = getTab(activeTabId || "");
  const isParentTab = activeTab?.displayMode === "parent";

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

  // Handle split view resize
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isSplitView || !containerRef.current) return;

    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startRatio = splitRatio;
    const container = containerRef.current;
    const containerWidth = container.offsetWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaRatio = deltaX / containerWidth;
      const newRatio = startRatio + deltaRatio;
      const clampedRatio = Math.max(0.2, Math.min(0.8, newRatio));
      setSplitRatio(clampedRatio);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    // Prevent text selection during drag
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
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
        return <ArtifactsView />; // Show artifacts view for document tabs
      case "app":
        return (
          <div className="content-area__placeholder">
            Mini-App View (Coming Soon)
          </div>
        );
      case "home":
        return (
          <div className="content-area__placeholder">
            Agent Lounge (Coming Soon)
          </div>
        );
      case "meetings":
        return (
          <div className="content-area__placeholder">
            Meetings View (Coming Soon)
          </div>
        );
      case "jobs":
        return (
          <div className="content-area__placeholder">
            Jobs View (Coming Soon)
          </div>
        );
      case "agents":
        return <ArtifactsView />; // Show artifacts view for browsing (temporary)
      case "skills":
        return (
          <div className="content-area__placeholder">
            Skills View (Coming Soon)
          </div>
        );
      case "settings":
        return <SettingsView />;
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
      style={{ "--split-ratio": splitRatio } as React.CSSProperties}
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
