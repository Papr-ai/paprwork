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

type HistoryEntry =
  | {
      kind: "chat";
      id: string;
      title: string;
      sortAt: number;
      chat: ChatMetadata;
    }
  | {
      kind: "app";
      id: string;
      title: string;
      sortAt: number;
      app: Artifact;
    };

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

function chatSortTime(chat: ChatMetadata): number {
  return new Date(chat.updatedAt || chat.createdAt).getTime();
}

function appSortTime(app: Artifact): number {
  return new Date(app.lastOpenedAt ?? app.updatedAt).getTime();
}

function matchesQuery(title: string, query: string): boolean {
  return title.toLowerCase().includes(query.toLowerCase());
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

function ChatHistoryIcon(): React.ReactElement {
  return (
    <span className="chat-history-item-icon chat-history-item-icon--chat">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path
          d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function sortNewestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.sortAt - a.sortAt);
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

  const chatEntries = useMemo((): HistoryEntry[] => {
    return chats
      .filter((chat) => isUserFacingChatId(chat.id))
      .map((chat) => ({
        kind: "chat" as const,
        id: chat.id,
        title: chat.title,
        sortAt: chatSortTime(chat),
        chat,
      }));
  }, [chats]);

  const appEntries = useMemo((): HistoryEntry[] => {
    return artifacts
      .filter((artifact) => artifact.type === "app")
      .filter((artifact) => (artifact.status ?? "active") !== "archived")
      .map((app) => ({
        kind: "app" as const,
        id: app.id,
        title: app.title,
        sortAt: appSortTime(app),
        app,
      }));
  }, [artifacts]);

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  const { mergedEntries, searchApps, searchChats } = useMemo(() => {
    if (!isSearching) {
      return {
        mergedEntries: sortNewestFirst([...chatEntries, ...appEntries]),
        searchApps: [] as HistoryEntry[],
        searchChats: [] as HistoryEntry[],
      };
    }

    const matchingApps = sortNewestFirst(
      appEntries.filter((entry) => matchesQuery(entry.title, trimmedQuery)),
    );
    const matchingChats = sortNewestFirst(
      chatEntries.filter((entry) => matchesQuery(entry.title, trimmedQuery)),
    );

    return {
      mergedEntries: [] as HistoryEntry[],
      searchApps: matchingApps,
      searchChats: matchingChats,
    };
  }, [appEntries, chatEntries, isSearching, trimmedQuery]);

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

  const renderEntry = (entry: HistoryEntry): React.ReactElement => {
    const timeLabel =
      entry.kind === "chat"
        ? formatRelativeTime(entry.chat.updatedAt || entry.chat.createdAt)
        : formatRelativeTime(entry.app.lastOpenedAt ?? entry.app.updatedAt);

    return (
      <button
        key={`${entry.kind}-${entry.id}`}
        type="button"
        className="chat-history-item"
        onClick={() =>
          entry.kind === "chat"
            ? void handleChatSelect(entry.chat.id, entry.chat.title)
            : handleAppSelect(entry.app)
        }
      >
        <div className="chat-history-item-content">
          {entry.kind === "chat" ? (
            <ChatHistoryIcon />
          ) : (
            renderAppIcon(entry.app.icon)
          )}
          <div className="chat-history-item-title">{entry.title}</div>
          <div className="chat-history-item-time">{timeLabel}</div>
        </div>
      </button>
    );
  };

  const hasResults = isSearching
    ? searchApps.length > 0 || searchChats.length > 0
    : mergedEntries.length > 0;

  return (
    <div className="chat-history-dropdown" ref={dropdownRef}>
      <div className="chat-history-search">
        <input
          type="text"
          placeholder="Search titles…"
          className="chat-history-search-input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="chat-history-list">
        {!hasResults ? (
          <div className="chat-history-empty">
            {isSearching ? "No results found" : "No recent history yet"}
          </div>
        ) : isSearching ? (
          <>
            {searchApps.length > 0 && (
              <div className="chat-history-section">
                <div className="chat-history-section-label">Apps</div>
                {searchApps.map(renderEntry)}
              </div>
            )}
            {searchChats.length > 0 && (
              <div className="chat-history-section">
                <div className="chat-history-section-label">Chats</div>
                {searchChats.map(renderEntry)}
              </div>
            )}
          </>
        ) : (
          mergedEntries.map(renderEntry)
        )}
      </div>
    </div>
  );
};
