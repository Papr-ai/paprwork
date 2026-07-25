/**
 * Sidebar - Left navigation panel with enhanced navigation
 * Reference: Paprwork v1 index.html lines 21-215
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import type { TabType } from "../../types/tabs";
import { WeatherWidget } from "./WeatherWidget";
import { NavButton } from "./NavButton";
import { FavoritesList } from "./FavoritesList";
import { NewChatButton } from "./NewChatButton";
import { OnboardingCard } from "./OnboardingCard";
import { ProfileFooter } from "./ProfileFooter";
import { SidebarToggleButton } from "./SidebarToggleButton";
import { MemoryIcon } from "../Memory/MemoryIcon";
import "./Sidebar.css";

type View = "chat" | "apps" | "memory" | "artifacts";

/** Map tab types to sidebar nav views */
function tabTypeToView(type: TabType | undefined): View {
  switch (type) {
    case "app":
    case "apps":
      return "apps";
    case "memory":
      return "memory";
    case "document":
    case "documents":
      return "artifacts";
    case "chat":
    default:
      return "chat";
  }
}

export function Sidebar({ onToggleCollapse }: { onToggleCollapse?: () => void }) {
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

  const handleOpenProfile = useCallback(() => {
    const settingsId = createTab("settings", "settings", "Settings");
    switchToTab(settingsId);
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("papr:open-settings", { detail: { tab: "profile" } }),
      );
    }, 60);
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
    } else if (view === "memory") {
      tabId = createTab("memory" as TabType, "memory", "Memory");
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

  useEffect(() => {
    const openCommunity = () => {
      const tabId = createTab("apps" as TabType, "apps", "Apps");
      switchToTab(tabId);
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("papr-apps-view-tab", { detail: { tab: "community" } }),
        );
      }, 100);
    };
    window.addEventListener("papr-open-community-apps", openCommunity);
    return () => window.removeEventListener("papr-open-community-apps", openCommunity);
  }, [createTab, switchToTab]);

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        {onToggleCollapse && (
          <SidebarToggleButton
            onClick={onToggleCollapse}
            ariaLabel="Hide sidebar"
          />
        )}
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
            icon={<MemoryIcon size={20} />}
            label="Memory"
            isActive={activeView === "memory"}
            onClick={() => handleNavClick("memory")}
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
          onOpenGettingStarted={handleOpenGettingStarted}
          onSendMessage={handleOnboardingSendMessage}
        />
        <ProfileFooter
          onOpenProfile={handleOpenProfile}
          onOpenSettings={handleOpenSettings}
        />
      </div>
    </div>
  );
}
