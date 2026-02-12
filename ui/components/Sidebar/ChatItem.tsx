/**
 * ChatItem - Individual chat in the sidebar
 */

import React, { useState } from "react";
import "./ChatItem.css";

interface ChatItemProps {
  chat: {
    id: string;
    title: string;
    updatedAt: string;
  };
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function ChatItem({
  chat,
  isActive,
  onSelect,
  onDelete,
}: ChatItemProps) {
  const [showDelete, setShowDelete] = useState(false);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("Delete this chat?")) {
      onDelete();
    }
  };

  // Format timestamp
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (hours < 1) return "Just now";
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div
      className={`chat-item ${isActive ? "chat-item--active" : ""}`}
      onClick={onSelect}
      onMouseEnter={() => setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
    >
      <div className="chat-item__content">
        <div className="chat-item__header">
          <h3 className="chat-item__title">{chat.title}</h3>
          <span className="chat-item__time">{formatTime(chat.updatedAt)}</span>
        </div>
      </div>
      {showDelete && !isActive && (
        <button
          className="chat-item__delete"
          onClick={handleDelete}
          aria-label="Delete chat"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
