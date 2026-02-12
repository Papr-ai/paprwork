/**
 * MessageItem Component - Individual chat message
 * Displays user or assistant messages with streaming support, thinking, and tool calls
 * Matches Paprwork v1 design exactly
 */

import React from "react";
import type { ChatMessage } from "../../stores/chatStore";
import { ThinkingCard } from "./ThinkingCard";
import { ExploringCard } from "./ExploringCard";
import { Markdown } from "../common/Markdown";
import "./MessageItem.css";

interface MessageItemProps {
  message: ChatMessage;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const isUser = message.role === "user";
  const content = message.isStreaming
    ? message.streamingContent || message.content
    : message.content;

  // Get reasoning content (streaming or final)
  const reasoning = message.isStreaming
    ? message.streamingReasoning || message.reasoning
    : message.reasoning;

  // TODO: Get user info from session/settings
  const userEmail = "user@example.com"; // Placeholder

  return (
    <div className="message-item">
      {/* Avatar - matches v1 exactly */}
      <div className="message-avatar-container">
        {isUser ? (
          // User avatar - uses Vercel avatar service as fallback
          <img
            src={`https://avatar.vercel.sh/${userEmail}`}
            alt="User Avatar"
            className="message-avatar-user"
          />
        ) : (
          // Assistant avatar - Papr logo (actual v1 logo)
          <div className="message-avatar-assistant">
            <svg
              width="16"
              height="16"
              viewBox="0 0 105 124"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="message-avatar-icon"
            >
              <path
                d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z"
                stroke="url(#papr-gradient)"
                strokeWidth="10"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <defs>
                <linearGradient
                  id="papr-gradient"
                  x1="17.2207"
                  y1="89.4214"
                  x2="68.8959"
                  y2="35.8394"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#0060E0" />
                  <stop offset="0.6" stopColor="#00ACFA" />
                  <stop offset="1" stopColor="#0BCDFF" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        )}
      </div>

      {/* Message content */}
      <div className="message-content">
        {/* Thinking card - only for assistant messages */}
        {!isUser && reasoning && (
          <ThinkingCard
            content={reasoning}
            isStreaming={message.isStreaming && !!message.streamingReasoning}
          />
        )}

        {/* Tool calls - only for assistant messages */}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <ExploringCard
            toolCalls={message.toolCalls}
            isStreaming={message.isStreaming}
          />
        )}

        {/* Main message text with markdown rendering */}
        {content && (
          <div className="message-text">
            <Markdown>{content}</Markdown>
            {message.isStreaming && !message.streamingReasoning && (
              <span className="streaming-cursor">▊</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
