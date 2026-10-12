/**
 * TabBar - Horizontal tab bar component with keyboard shortcuts
 * Reference: Paprwork v1 app.js lines 9994-10192
 */

import React, { useEffect, useState, useRef } from "react";
import { useTabs } from "../../hooks/useTabs";
import { useChat } from "../../hooks/useChat";
import { useChatStore } from "../../stores/chatStore";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import { Tab } from "./Tab";
import { ChatHistoryDropdown } from "../Chat/ChatHistoryDropdown";
import "./TabBar.css";

// Platform-aware modifier key
const isMac = navigator.platform.toUpperCase().includes("MAC");
const modKey = isMac ? "⌘" : "Ctrl+";

export function TabBar() {
  const {
    tabs,
    getVisibleTabs,
    activeLeftTab,
    createTab,
    switchToTab,
    closeTab,
    moveTab,
  } = useTabs();
  const chats = useChatStore((s) => s.chats);
  const { createChat } = useChat();
  const [dropIndicatorStyle, setDropIndicatorStyle] =
    useState<React.CSSProperties>({ display: "none" });
  const [dropIndicatorOnTop, setDropIndicatorOnTop] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // "hover" peeks like the rail (closes when the pointer leaves, no focus steal);
  // "click" pins it open with the search focused until an outside click.
  const [historyMode, setHistoryMode] = useState<"hover" | "click">("click");
  const hoverTimer = useRef<number | undefined>(undefined);
  const clearHoverTimer = () => window.clearTimeout(hoverTimer.current);
  const onHistoryEnter = () => {
    clearHoverTimer();
    if (showHistory) return;
    // Same 120ms hover intent as the rail peeks.
    hoverTimer.current = window.setTimeout(() => {
      setHistoryMode("hover");
      setShowHistory(true);
    }, 120);
  };
  const onHistoryLeave = () => {
    clearHoverTimer();
    if (!showHistory || historyMode !== "hover") return;
    hoverTimer.current = window.setTimeout(() => setShowHistory(false), 180);
  };
  const onHistoryClick = () => {
    clearHoverTimer();
    if (showHistory && historyMode === "click") {
      setShowHistory(false);
      return;
    }
    setHistoryMode("click");
    setShowHistory(true);
  };
  useEffect(() => clearHoverTimer, []);

  // Rail "All chats" opens this same history dropdown.
  useEffect(() => {
    const open = () => {
      setHistoryMode("click");
      setShowHistory(true);
    };
    window.addEventListener("papr-open-chat-history", open);
    return () => window.removeEventListener("papr-open-chat-history", open);
  }, []);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const historyDropdownRef = useRef<HTMLDivElement>(null);

  useDismissOnOutsideClick(
    showHistory,
    () => setShowHistory(false),
    historyBtnRef,
    historyDropdownRef,
  );

  // Scroll active tab into view when it changes
  useEffect(() => {
    if (!activeLeftTab || !tabBarRef.current) return;

    // Find the active tab element
    const activeTabElement = tabBarRef.current.querySelector(
      `.tab--active`,
    ) as HTMLElement;

    if (activeTabElement) {
      // Scroll the active tab into view with smooth behavior
      activeTabElement.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [activeLeftTab]);

  // Define handleNewTab before useEffect so it can be in the dependency array
  const handleNewTab = async () => {
    const chatId = await createChat();
    if (chatId) {
      // Explicit user action (+ button / Cmd+T) — forceNew skips blank-chat
      // reuse so the click always produces a visible new tab.
      const tabId = createTab("chat", chatId, "New Chat", {}, { forceNew: true });
      switchToTab(tabId);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      if (!modifier) return;

      // Cmd/Ctrl+T: New tab
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        handleNewTab();
        return;
      }

      // Cmd/Ctrl+W: Close current tab
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (activeLeftTab) {
          closeTab(activeLeftTab);
        }
        return;
      }

      // Cmd/Ctrl+Tab or Cmd/Ctrl+]: Next tab
      if (e.key === "Tab" || e.key === "]") {
        e.preventDefault();
        const currentIndex = tabs.findIndex((t) => t.id === activeLeftTab);
        if (currentIndex < tabs.length - 1) {
          switchToTab(tabs[currentIndex + 1].id);
        } else if (tabs.length > 0) {
          switchToTab(tabs[0].id); // Wrap to first
        }
        return;
      }

      // Cmd/Ctrl+Shift+Tab or Cmd/Ctrl+[: Previous tab
      if ((e.key === "Tab" && e.shiftKey) || e.key === "[") {
        e.preventDefault();
        const currentIndex = tabs.findIndex((t) => t.id === activeLeftTab);
        if (currentIndex > 0) {
          switchToTab(tabs[currentIndex - 1].id);
        } else if (tabs.length > 0) {
          switchToTab(tabs[tabs.length - 1].id); // Wrap to last
        }
        return;
      }

      // Cmd/Ctrl+1-9: Switch to tab by index
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9) {
        e.preventDefault();
        if (tabs[num - 1]) {
          switchToTab(tabs[num - 1].id);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tabs, activeLeftTab, createTab, switchToTab, closeTab, handleNewTab]);

  const { goBack, goForward, canGoBack, canGoForward } = useTabs();

  const handleBack = () => {
    goBack();
  };

  const handleForward = () => {
    goForward();
  };

  const handleDragPositionChange = (
    position: "before" | "after" | "on-top" | null,
    targetElement: HTMLElement | null,
  ) => {
    if (!position || !targetElement || !tabBarRef.current) {
      setDropIndicatorStyle({ display: "none" });
      setDropIndicatorOnTop(false);
      return;
    }

    const tabBarRect = tabBarRef.current.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    // Account for horizontal scroll offset (V1 pattern)
    // Without this, the indicator drifts when tabs are scrolled right
    const scrollLeft = tabBarRef.current.scrollLeft || 0;
    const leftOffset = targetRect.left - tabBarRect.left + scrollLeft;

    if (position === "on-top") {
      // Full outline around target tab
      setDropIndicatorStyle({
        display: "block",
        left: `${leftOffset}px`,
        top: "12px",
        width: `${targetRect.width}px`,
        height: "28px",
      });
      setDropIndicatorOnTop(true);
    } else {
      // Vertical bar at edge
      const left =
        position === "before"
          ? leftOffset - 2
          : leftOffset + targetRect.width - 1;

      setDropIndicatorStyle({
        display: "block",
        left: `${left}px`,
        top: "12px",
        width: "3px",
        height: "28px",
      });
      setDropIndicatorOnTop(false);
    }
  };

  return (
    <div className="tab-bar">
      {/* Navigation controls */}
      <div className="tab-bar__nav">
        <button
          className="tab-bar__nav-btn"
          onClick={handleBack}
          disabled={!canGoBack()}
          title="Back"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M19 12H5M12 19l-7-7 7-7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="tab-bar__nav-btn"
          onClick={handleForward}
          disabled={!canGoForward()}
          title="Forward"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12h14M12 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="tab-bar__tabs" id="header-tabs" ref={tabBarRef}>
        {getVisibleTabs().map((tab, visibleIndex) => {
          // Only show standalone and parent tabs (children are hidden)
          const isActive = tab.id === activeLeftTab;

          // Check if this is a parent tab with children
          const isParent =
            tab.displayMode === "parent" && tab.childTabIds.length > 0;
          const leftChild =
            isParent && tab.childTabIds[0]
              ? tabs.find((t) => t.id === tab.childTabIds[0])
              : undefined;
          const rightChild =
            isParent && tab.childTabIds[1]
              ? tabs.find((t) => t.id === tab.childTabIds[1])
              : undefined;

          // For merged display, show the first child as the "right tab"
          const displayRightTab = leftChild || rightChild;

          // Get streaming/unread status for chat tabs
          const chatMetadata =
            tab.type === "chat"
              ? chats.find((c) => c.id === tab.entityId)
              : undefined;
          const isStreaming = chatMetadata?.isStreaming || false;
          const hasUnread = chatMetadata?.hasUnread || false;

          // CRITICAL: Pass the actual index from the full tabs array, not just visible tabs
          const actualTabIndex = tabs.findIndex((t) => t.id === tab.id);

          return (
            <Tab
              key={tab.id}
              tab={tab}
              isActive={isActive}
              isMerged={isParent}
              rightTab={displayRightTab}
              tabIndex={actualTabIndex}
              isStreaming={isStreaming}
              hasUnread={hasUnread}
              onDragPositionChange={handleDragPositionChange}
            />
          );
        })}

        {/* Drop indicator */}
        <div
          className={`tab-drop-indicator ${dropIndicatorOnTop ? "tab-drop-indicator--on-top" : ""}`}
          style={dropIndicatorStyle}
        />
      </div>

      <div className="tab-bar__actions">
        <button
          className="tab-bar__action-btn"
          onClick={handleNewTab}
          aria-label="New tab"
          title={`New tab (${modKey}T)`}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 2v10M2 7h10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div
          className="tab-bar__history"
          onMouseEnter={onHistoryEnter}
          onMouseLeave={onHistoryLeave}
        >
        <button
          ref={historyBtnRef}
          className="tab-bar__action-btn"
          onClick={onHistoryClick}
          aria-expanded={showHistory}
          aria-label="Recent history"
          title="Recent chats and apps"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M12 6v6l4 2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {showHistory && (
          <ChatHistoryDropdown
            onClose={() => setShowHistory(false)}
            dropdownRef={historyDropdownRef}
            autoFocusSearch={historyMode === "click"}
            onInteract={() => setHistoryMode("click")}
          />
        )}
        </div>
      </div>
    </div>
  );
}
