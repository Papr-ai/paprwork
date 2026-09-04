/**
 * ChatHistoryDropdown - Recent chats and apps for quick navigation
 */

import React, { useEffect, useMemo } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";
import { useArtifactsStore, type Artifact } from "../../stores/artifactsStore";
import { useChat } from "../../hooks/useChat";
import { useArtifacts } from "../../hooks/useArtifacts";
import type { ChatMetadata } from "../../types/chat";
import { isUserFacingChatId } from "../../utils/chatVisibility";
import { gateway } from "../../src/lib/gateway";
import "./ChatHistoryDropdown.css";

interface ChatHistoryDropdownProps {
  onClose: () => void;
  dropdownRef?: React.RefObject<HTMLDivElement | null>;
}

function groupChatsByDate(
  chats: ChatMetadata[],
): Record<string, ChatMetadata[]> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: Record<string, ChatMetadata[]> = {
    Today: [],
    Yesterday: [],
    "This Week": [],
    "This Month": [],
    Older: [],
  };

  chats.forEach((chat) => {
    const chatDate = new Date(chat.updatedAt || chat.createdAt);
    const chatDay = new Date(
      chatDate.getFullYear(),
      chatDate.getMonth(),
      chatDate.getDate(),
    );

    if (chatDay.getTime() === today.getTime()) {
      groups.Today.push(chat);
    } else if (chatDay.getTime() === yesterday.getTime()) {
      groups.Yesterday.push(chat);
    } else if (
      chatDay.getTime() >
      new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).getTime()
    ) {
      groups["This Week"].push(chat);
    } else if (
      chatDate.getMonth() === now.getMonth() &&
      chatDate.getFullYear() === now.getFullYear()
    ) {
      groups["This Month"].push(chat);
    } else {
      groups.Older.push(chat);
    }
  });

  Object.keys(groups).forEach((key) => {
    if (groups[key].length === 0) {
      delete groups[key];
    }
  });

  return groups;
}

function formatRelativeTime(dateString: string): string {
  if (!dateString) return "";

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) {
    return "now";
  }
  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  return `${diffDays}d`;
}

function renderAppIcon(icon: string | undefined): React.ReactNode {
  if (!icon) {
    return (
      <span className="chat-history-item-icon chat-history-item-icon--fallback">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <rect
            x="3"
            y="3"
            width="7"
            height="7"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <rect
            x="14"
            y="3"
            width="7"
            height="7"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <rect
            x="3"
            y="14"
            width="7"
            height="7"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <rect
            x="14"
            y="14"
            width="7"
            height="7"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </span>
    );
  }

  const trimmedIcon = icon.trim();
  if (trimmedIcon.startsWith("<")) {
    return (
      <span
        className="chat-history-item-icon chat-history-item-icon--svg"
        dangerouslySetInnerHTML={{ __html: trimmedIcon }}
      />
    );
  }

  const isEmoji =
    trimmedIcon.length <= 4 && /[\p{Emoji}]/u.test(trimmedIcon);
  if (isEmoji) {
    return (
      <span className="chat-history-item-icon chat-history-item-icon--emoji">
        {trimmedIcon}
      </span>
    );
  }

  return (
    <span className="chat-history-item-icon chat-history-item-icon--fallback">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <rect
          x="3"
          y="3"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect
          x="14"
          y="3"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect
          x="3"
          y="14"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect
          x="14"
          y="14"
          width="7"
          height="7"
          rx="1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </span>
  );
}

export const ChatHistoryDropdown: React.FC<ChatHistoryDropdownProps> = ({
  onClose,
  dropdownRef,
}) => {
  const { chats } = useChatStore();
  const artifacts = useArtifactsStore((state) => state.artifacts);
  const { loadArtifacts } = useArtifacts("apps");
  const { createTab } = useTabStore();
  const { loadMessages } = useChat();
  const [searchQuery, setSearchQuery] = React.useState("");

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  const groupedChats = useMemo(() => {
    const filtered = chats
      .filter((chat) => isUserFacingChatId(chat.id))
      .filter((chat) =>
        chat.title.toLowerCase().includes(searchQuery.toLowerCase()),
      );

    const sorted = [...filtered].sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime(),
    );
    return groupChatsByDate(sorted);
  }, [chats, searchQuery]);

  const recentApps = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return artifacts
      .filter((artifact) => artifact.type === "app")
      .filter((artifact) => (artifact.status ?? "active") !== "archived")
      .filter((artifact) => Boolean(artifact.lastOpenedAt))
      .filter((artifact) => artifact.title.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          new Date(b.lastOpenedAt ?? b.updatedAt).getTime() -
          new Date(a.lastOpenedAt ?? a.updatedAt).getTime(),
      );
  }, [artifacts, searchQuery]);

  const handleChatSelect = async (chatId: string, title: string) => {
    await loadMessages(chatId);
    createTab("chat", chatId, title);
    onClose();
  };

  const handleAppSelect = (app: Artifact) => {
    createTab(
      "app",
      app.id,
      app.title,
      app.icon ? { icon: app.icon } : {},
    );
    void gateway
      .send("app:update", {
        appId: app.id,
        lastOpenedAt: new Date().toISOString(),
        openCount: (app.openCount ?? 0) + 1,
      })
      .then(() => loadArtifacts())
      .catch(() => {});
    onClose();
  };

  const hasChatResults = Object.keys(groupedChats).length > 0;
  const hasAppResults = recentApps.length > 0;
  const hasResults = hasChatResults || hasAppResults;

  return (
    <div className="chat-history-dropdown" ref={dropdownRef}>
      <div className="chat-history-search">
        <input
          type="text"
          placeholder="Search chats and apps..."
          className="chat-history-search-input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="chat-history-list">
        {!hasResults ? (
          <div className="chat-history-empty">
            {searchQuery ? "No results found" : "No recent history yet"}
          </div>
        ) : (
          <>
            {hasChatResults && (
              <div className="chat-history-section">
                <div className="chat-history-section-label">Chats</div>
                {Object.entries(groupedChats).map(([group, groupChats]) => (
                  <div key={group} className="chat-history-group">
                    <div className="chat-history-group-label">{group}</div>
                    {groupChats.map((chat) => (
                      <button
                        key={chat.id}
                        type="button"
                        className="chat-history-item"
                        onClick={() => handleChatSelect(chat.id, chat.title)}
                      >
                        <div className="chat-history-item-content">
                          <span className="chat-history-item-icon chat-history-item-icon--chat">
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                            >
                              <path
                                d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                          <div className="chat-history-item-title">
                            {chat.title}
                          </div>
                          <div className="chat-history-item-time">
                            {formatRelativeTime(
                              chat.updatedAt || chat.createdAt,
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {hasAppResults && (
              <div className="chat-history-section">
                <div className="chat-history-section-label">Apps</div>
                {recentApps.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    className="chat-history-item"
                    onClick={() => handleAppSelect(app)}
                  >
                    <div className="chat-history-item-content">
                      {renderAppIcon(app.icon)}
                      <div className="chat-history-item-title">{app.title}</div>
                      <div className="chat-history-item-time">
                        {formatRelativeTime(
                          app.lastOpenedAt ?? app.updatedAt,
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
