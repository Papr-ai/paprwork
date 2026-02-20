/**
 * ChatHistoryDropdown - Compact chat history selector
 * Shows list of chats grouped by date (Today, Yesterday, etc.)
 */

import React, { useMemo } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";
import { useChat } from "../../hooks/useChat";
import type { ChatMetadata } from "../../types/chat";
import "./ChatHistoryDropdown.css";

interface ChatHistoryDropdownProps {
  onClose: () => void;
}

// Group chats by date
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

  // Remove empty groups
  Object.keys(groups).forEach((key) => {
    if (groups[key].length === 0) {
      delete groups[key];
    }
  });

  return groups;
}

// Format relative time (14m, 3h, 5h, 12h, etc.)
function formatRelativeTime(dateString: string): string {
  if (!dateString) return "";

  const date = new Date(dateString);

  // Check if date is valid
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
  } else if (diffMins < 60) {
    return `${diffMins}m`;
  } else if (diffHours < 24) {
    return `${diffHours}h`;
  } else {
    return `${diffDays}d`;
  }
}

export const ChatHistoryDropdown: React.FC<ChatHistoryDropdownProps> = ({
  onClose,
}) => {
  const { chats } = useChatStore();
  const { createTab } = useTabStore();
  const { loadMessages } = useChat();
  const [searchQuery, setSearchQuery] = React.useState("");

  // Filter and sort chats based on search
  const groupedChats = useMemo(() => {
    const filtered = chats.filter((chat) =>
      chat.title.toLowerCase().includes(searchQuery.toLowerCase()),
    );

    const sorted = [...filtered].sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime(),
    );
    return groupChatsByDate(sorted);
  }, [chats, searchQuery]);

  const handleChatSelect = async (chatId: string, title: string) => {
    // Load messages for this chat first
    await loadMessages(chatId);

    // Then create/switch to the tab
    createTab("chat", chatId, title);
    onClose();
  };

  return (
    <div className="chat-history-dropdown">
      <div className="chat-history-search">
        <input
          type="text"
          placeholder="Search..."
          className="chat-history-search-input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="chat-history-list">
        {Object.keys(groupedChats).length === 0 ? (
          <div
            style={{
              padding: "20px",
              textAlign: "center",
              color: "#666",
              fontSize: "13px",
            }}
          >
            {searchQuery ? "No chats found" : "No chat history yet"}
          </div>
        ) : (
          Object.entries(groupedChats).map(([group, groupChats]) => (
            <div key={group} className="chat-history-group">
              <div className="chat-history-group-label">{group}</div>
              {groupChats.map((chat) => (
                <button
                  key={chat.id}
                  className="chat-history-item"
                  onClick={() => handleChatSelect(chat.id, chat.title)}
                >
                  <div className="chat-history-item-content">
                    <div className="chat-history-item-title">{chat.title}</div>
                    <div className="chat-history-item-time">
                      {formatRelativeTime(chat.updatedAt || chat.createdAt)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
