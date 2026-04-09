/**
 * Sidebar - Left navigation panel with enhanced navigation
 * Reference: Paprwork v1 index.html lines 21-215
 */

import { useState, useMemo, useCallback } from "react";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import type { TabType } from "../../types/tabs";
import { WeatherWidget } from "./WeatherWidget";
import { NavButton } from "./NavButton";
import { FavoritesList } from "./FavoritesList";
import { NewChatButton } from "./NewChatButton";
import { OnboardingCard } from "./OnboardingCard";
import { ConnectionIndicator } from "../ConnectionIndicator/ConnectionIndicator";
import "./Sidebar.css";

type View = "chat" | "apps" | "artifacts";

/** Map tab types to sidebar nav views */
function tabTypeToView(type: TabType | undefined): View {
  switch (type) {
    case "app":
    case "apps":
      return "apps";
    case "document":
    case "documents":
      return "artifacts";
    case "chat":
    default:
      return "chat";
  }
}

export function Sidebar() {
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const { createChat } = useChat();
  const { tabs, createTab, switchToTab, activeLeftTab } = useTabs();

  // Derive active view from the current left-pane tab type
  // For split view, activeLeftTab is the parent/left pane
  const activeView = useMemo<View>(() => {
    if (!activeLeftTab) return "chat";
    const tab = tabs.find((t) => t.id === activeLeftTab);
    if (!tab) return "chat";

    // For parent tabs (split view), use the parent's own type
    // If parent type is generic (e.g. "chat"), that's correct
    // If it's a document/app parent, it maps to "artifacts"
    return tabTypeToView(tab.type);
  }, [activeLeftTab, tabs]);

  const handleNewChat = async () => {
    // Prevent multiple simultaneous chat creations
    if (isCreatingChat) {
      console.log("[Sidebar] Already creating a chat, ignoring click");
      return;
    }

    setIsCreatingChat(true);
    try {
      // Create new chat - createTab will handle empty chat detection automatically
      const chatId = await createChat();
      if (chatId) {
        // createTab will check for empty chats and reuse if found
        const tabId = createTab("chat", chatId, "New Chat");
        switchToTab(tabId);
      }
    } finally {
      setIsCreatingChat(false);
    }
  };

  const handleOpenSettings = useCallback(() => {
    const settingsId = createTab("settings", "settings", "Settings");
    switchToTab(settingsId);
  }, [createTab, switchToTab]);

  const handleOpenGettingStarted = useCallback(() => {
    const tabId = createTab("getting-started", "default", "Getting Started");
    switchToTab(tabId);
  }, [createTab, switchToTab]);

  const handleOnboardingSendMessage = useCallback(
    async (message: string) => {
      // Create a new chat, switch to it, then dispatch event for ChatContainer to send
      const chatId = await createChat();
      if (chatId) {
        const tabId = createTab("chat", chatId, "New Chat");
        switchToTab(tabId);
        // Give the ChatContainer a moment to mount, then dispatch send event
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("papr-onboarding-send", { detail: { message } }),
          );
        }, 300);
      }
    },
    [createChat, createTab, switchToTab],
  );

  const handleNavClick = (view: View) => {
    let tabId: string | undefined;
    if (view === "apps") {
      tabId = createTab("apps" as TabType, "apps", "Apps");
    } else if (view === "artifacts") {
      tabId = createTab("documents" as TabType, "documents", "Artifacts");
    } else if (view === "chat") {
      handleNewChat();
      return;
    }

    if (tabId) {
      switchToTab(tabId);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <h1 className="sidebar__title" style={{ marginLeft: "70px" }}></h1>
      </div>

      <div className="sidebar__content">
        <WeatherWidget />

        <NewChatButton onClick={() => handleNavClick("apps")} />

        <div className="sidebar__nav">
          <NavButton
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path
                  d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
            label="Chat"
            isActive={activeView === "chat"}
            onClick={() => handleNavClick("chat")}
          />
          <NavButton
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect
                  x="3"
                  y="3"
                  width="7"
                  height="7"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="14"
                  y="3"
                  width="7"
                  height="7"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="3"
                  y="14"
                  width="7"
                  height="7"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="14"
                  y="14"
                  width="7"
                  height="7"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            }
            label="Apps"
            isActive={activeView === "apps"}
            onClick={() => handleNavClick("apps")}
          />
          <NavButton
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M14 2v6h6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <line
                  x1="9"
                  y1="13"
                  x2="15"
                  y2="13"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <line
                  x1="9"
                  y1="17"
                  x2="15"
                  y2="17"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            }
            label="Artifacts"
            isActive={activeView === "artifacts"}
            onClick={() => handleNavClick("artifacts")}
          />
        </div>

        <FavoritesList />

        {/* Spacer between nav and favorites */}
      </div>

      <div className="sidebar__footer">
        <OnboardingCard
          onOpenSettings={handleOpenSettings}
          onOpenGettingStarted={handleOpenGettingStarted}
          onSendMessage={handleOnboardingSendMessage}
        />
        <div className="sidebar__footer-buttons">
          <ConnectionIndicator />
          <button
            className="sidebar__settings-btn"
            aria-label="Settings"
            onClick={handleOpenSettings}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle
                cx="12"
                cy="12"
                r="3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}
