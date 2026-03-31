/**
 * TabBar - Horizontal tab bar component with keyboard shortcuts
 * Reference: Paprwork v1 app.js lines 9994-10192
 */

import React, { useEffect, useState, useRef } from "react";
import { useTabs } from "../../hooks/useTabs";
import { useChat } from "../../hooks/useChat";
import { useChatStore } from "../../stores/chatStore";
import { Tab } from "./Tab";
import { gateway } from "../../src/lib/gateway";
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
  const { chats } = useChatStore();
  const { createChat } = useChat();
  const chatStore = useChatStore();
  const [dropIndicatorStyle, setDropIndicatorStyle] =
    useState<React.CSSProperties>({ display: "none" });
  const [dropIndicatorOnTop, setDropIndicatorOnTop] = useState(false);
  const tabBarRef = useRef<HTMLDivElement>(null);

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
    // Create new chat - createTab will handle empty chat detection automatically
    const chatId = await createChat();
    if (chatId) {
      // createTab will check for empty chats and reuse if found
      const tabId = createTab("chat", chatId, "New Chat");
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

  const handleHome = async () => {
    console.log('[TabBar] Home button clicked');
    
    // Check if there's a default home app configured
    try {
      console.log('[TabBar] Fetching settings...');
      const response = await gateway.send('settings:get', {});
      console.log('[TabBar] Settings response:', response);
      
      const defaultHomeAppId = response?.data?.preferences?.defaultHomeAppId;
      console.log('[TabBar] defaultHomeAppId:', defaultHomeAppId);
      
      if (defaultHomeAppId) {
        // Get app details (just to verify it exists)
        console.log('[TabBar] Fetching app list...');
        const appsResponse = await gateway.send('app:list', {});
        console.log('[TabBar] Apps response:', appsResponse);
        console.log('[TabBar] Apps array:', appsResponse?.data);
        console.log('[TabBar] Apps length:', appsResponse?.data?.length);
        console.log('[TabBar] First app:', appsResponse?.data?.[0]);
        
        const app = appsResponse?.data?.find((a: any) => a.id === defaultHomeAppId);
        console.log('[TabBar] Found app:', app);
        
        if (app) {
          // Open the configured home app with "Home" as the title and home icon
          console.log('[TabBar] Creating app tab:', defaultHomeAppId, 'Home');
          const homeIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
          createTab("app", defaultHomeAppId, "Home", { icon: homeIcon });
          return;
        } else {
          console.warn('[TabBar] App not found in list, falling back to home tab');
        }
      } else {
        console.log('[TabBar] No defaultHomeAppId configured, creating home tab');
      }
    } catch (error) {
      console.error('[TabBar] Failed to check default home app:', error);
    }
    
    // Fallback: Create regular home tab
    console.log('[TabBar] Creating fallback home tab');
    createTab("home", "home", "Home");
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
        <button className="tab-bar__nav-btn" onClick={handleHome} title="Home">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"
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

        <button
          className="tab-bar__new-btn"
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
      </div>
    </div>
  );
}
