/**
 * Sidebar - Left navigation panel with enhanced navigation
 * Reference: Paprwork v1 index.html lines 21-215
 */

import React, { useState } from "react";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import { WeatherWidget } from "./WeatherWidget.tsx";
import { NavButton } from "./NavButton.tsx";
import { FavoritesList } from "./FavoritesList.tsx";
import { ChatList } from "./ChatList.tsx";
import { NewChatButton } from "./NewChatButton.tsx";
import "./Sidebar.css";

type View = "chat" | "artifacts" | "meetings" | "agents" | "jobs" | "skills";

export function Sidebar() {
  const [activeView, setActiveView] = useState<View>("chat");
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();

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

  const handleNavClick = (view: View) => {
    setActiveView(view);

    // Create appropriate tab when clicking navigation and switch to it
    let tabId: string | undefined;
    if (view === "artifacts") {
      tabId = createTab("document", "artifacts", "Artifacts");
    } else if (view === "agents") {
      tabId = createTab("agents", "agents", "Agents");
    } else if (view === "meetings") {
      tabId = createTab("meetings", "meetings", "Meetings");
    } else if (view === "jobs") {
      tabId = createTab("jobs", "jobs", "Jobs");
    } else if (view === "skills") {
      tabId = createTab("skills", "skills", "Skills");
    } else if (view === "chat") {
      // For chat, create a new chat
      handleNewChat();
      return;
    }

    // Switch to the created tab
    if (tabId) {
      switchToTab(tabId);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <h1 className="sidebar__title" style={{ marginLeft: "70px" }}>
          
        </h1>
      </div>

      <div className="sidebar__content">
        <WeatherWidget />

        <NewChatButton onClick={handleNewChat} />

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
              </svg>
            }
            label="Artifacts"
            isActive={activeView === "artifacts"}
            onClick={() => handleNavClick("artifacts")}
          />
          <NavButton
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect
                  x="3"
                  y="4"
                  width="18"
                  height="18"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <line
                  x1="3"
                  y1="10"
                  x2="21"
                  y2="10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <line
                  x1="8"
                  y1="2"
                  x2="8"
                  y2="6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <line
                  x1="16"
                  y1="2"
                  x2="16"
                  y2="6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            }
            label="Meetings"
            isActive={activeView === "meetings"}
            onClick={() => handleNavClick("meetings")}
          />
          <NavButton
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="8"
                  r="4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            }
            label="Agents"
            isActive={activeView === "agents"}
            onClick={() => handleNavClick("agents")}
          />
          <NavButton
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="12"
                  r="3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            }
            label="Jobs"
            isActive={activeView === "jobs"}
            onClick={() => handleNavClick("jobs")}
          />
          <NavButton
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path
                  d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
            label="Skills"
            isActive={activeView === "skills"}
            onClick={() => handleNavClick("skills")}
          />
        </div>

        <FavoritesList />

        {/* Don't show chat list when in chat mode - chats are in tabs */}
        {activeView !== "chat" && activeView === "artifacts" && (
          <div className="section-divider" />
        )}
        {activeView === "artifacts" && (
          <div
            style={{
              padding: "16px",
              color: "var(--text-secondary)",
              fontSize: "13px",
            }}
          >
            Click a tab above to view artifacts
          </div>
        )}
        {(activeView === "meetings" ||
          activeView === "agents" ||
          activeView === "jobs" ||
          activeView === "skills") && (
          <div
            style={{
              padding: "16px",
              color: "var(--text-secondary)",
              fontSize: "13px",
            }}
          >
            Coming soon
          </div>
        )}
      </div>

      <div className="sidebar__footer">
        <button
          className="sidebar__settings-btn"
          aria-label="Settings"
          onClick={() => {
            const settingsId = createTab("settings", "settings", "Settings");
            switchToTab(settingsId);
          }}
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
  );
}
