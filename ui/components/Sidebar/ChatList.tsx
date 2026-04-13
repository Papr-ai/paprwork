/**
 * ChatList - List of all chat sessions
 */

import React from "react";
import { useChat } from "../../hooks/useChat";
import { isUserFacingChatId } from "../../utils/chatVisibility";
import { ChatItem } from "./ChatItem";
import "./ChatList.css";

export function ChatList() {
  const { chats, activeChat, switchChat, deleteChat, isLoading } = useChat();
  const userChats = chats.filter((c) => isUserFacingChatId(c.id));

  if (isLoading) {
    return (
      <div className="chat-list__loading">
        <div className="chat-list__spinner" />
        <p>Loading chats...</p>
      </div>
    );
  }

  if (userChats.length === 0) {
    return (
      <div className="chat-list__empty">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <p>No chats yet</p>
        <span>Create a new chat to get started</span>
      </div>
    );
  }

  return (
    <div className="chat-list">
      {userChats.map((chat) => (
        <ChatItem
          key={chat.id}
          chat={chat}
          isActive={chat.id === activeChat}
          onSelect={() => switchChat(chat.id)}
          onDelete={() => deleteChat(chat.id)}
        />
      ))}
    </div>
  );
}
