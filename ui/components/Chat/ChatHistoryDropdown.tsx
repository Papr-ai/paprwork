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
import { useChatActivity } from "./chatActivity";
import { PeekRowView, relativeTime, type PeekRow } from "../Sidebar/RailPeek";
import "../Sidebar/Sidebar.css";
import "./ChatHistoryDropdown.css";

interface ChatHistoryDropdownProps {
  onClose: () => void;
  dropdownRef?: React.RefObject<HTMLDivElement | null>;
  /** Focus search on open — off for hover peeks so the composer keeps focus. */
  autoFocusSearch?: boolean;
  /** Typing in search pins a hover peek open. */
  onInteract?: () => void;
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
  autoFocusSearch = true,
  onInteract,
}) => {
  const { chats } = useChatStore();
  const artifacts = useArtifactsStore((state) => state.artifacts);
  const { loadArtifacts } = useArtifacts("apps");
  const { createTab } = useTabStore();
  const { loadMessages } = useChat();
  const [searchQuery, setSearchQuery] = React.useState("");
  const activityOf = useChatActivity();

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

  // Rows render with the rail peek's own row component + classes, so spacing, type, hover and
  // status marks are identical to the left-nav Chats peek (no parallel CSS to drift).
  const toRow = (entry: HistoryEntry): PeekRow =>
    entry.kind === "chat"
      ? {
          id: `chat-${entry.id}`,
          title: entry.title,
          sub: relativeTime(entry.chat.updatedAt || entry.chat.createdAt),
          activity: activityOf(entry.chat.id),
          leading: <ChatHistoryIcon />,
          onOpen: () => void handleChatSelect(entry.chat.id, entry.chat.title),
        }
      : {
          id: `app-${entry.id}`,
          title: entry.title,
          sub: relativeTime(entry.app.lastOpenedAt ?? entry.app.updatedAt),
          leading: renderAppIcon(entry.app.icon),
          onOpen: () => handleAppSelect(entry.app),
        };

  const renderGroup = (label: string, entries: HistoryEntry[]) => (
    <div className="rail-peek__group" key={label}>
      <h6>{label}</h6>
      {entries.map((e) => {
        const row = toRow(e);
        return <PeekRowView key={row.id} row={row} />;
      })}
    </div>
  );

  const hasResults = isSearching
    ? searchApps.length > 0 || searchChats.length > 0
    : mergedEntries.length > 0;

  return (
    <div className="chat-history-dropdown rail-scope" ref={dropdownRef}>
      <div className="chat-history-search">
        <input
          type="text"
          placeholder="Search titles…"
          className="chat-history-search-input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={onInteract}
          autoFocus={autoFocusSearch}
        />
      </div>

      <div className="chat-history-list">
        {!hasResults ? (
          <p className="rail-peek__empty">
            {isSearching ? "No results found" : "No recent history yet"}
          </p>
        ) : isSearching ? (
          <>
            {searchApps.length > 0 && renderGroup("Apps", searchApps)}
            {searchChats.length > 0 && renderGroup("Chats", searchChats)}
          </>
        ) : (
          renderGroup("Recent", mergedEntries)
        )}
      </div>
    </div>
  );
};
