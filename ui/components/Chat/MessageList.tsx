/**
 * MessageList Component - Scrollable list of messages
 */

import React, { useLayoutEffect, useRef, useEffect } from "react";
import { MessageItem } from "./MessageItem";
import { WelcomeMessage } from "./WelcomeMessage";
import { PermissionCard } from "./PermissionCard";
import { usePermissionStore } from "../../stores/permissionStore";
import type { ChatMessage } from "../../stores/chatStore";
import "./MessageList.css";

interface MessageListProps {
  chatId: string;
  messages: ChatMessage[];
  isLoading?: boolean;
  isSending?: boolean;
  /** When set, file drops on the list attach the same way as Add context → file upload */
  onFilesDropped?: (files: File[]) => void;
}

export const MessageList: React.FC<MessageListProps> = ({
  chatId,
  messages,
  isLoading,
  isSending,
  onFilesDropped,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeRequest = usePermissionStore((s) => s.activeRequest);
  const autoScrollEnabled = useRef(true);
  const lastScrollHeight = useRef(0);

  // Filter out sub-agent trigger messages from main chat (they appear in MiniChatCard)
  const filteredMessages = messages.filter((msg) => {
    // Hide synthetic sub-agent user messages
    if (
      msg.role === "user" &&
      (msg.content.startsWith("[Sub-agent question for delegation ") ||
        msg.content.startsWith("[User message in sub-agent chat for delegation "))
    ) {
      return false;
    }
    // Hide assistant responses that use respond_to_sub_agent (sub-agent interactions)
    if (
      msg.role === "assistant" &&
      msg.toolCalls &&
      msg.toolCalls.some((tc) => tc.toolName === "respond_to_sub_agent")
    ) {
      return false;
    }
    return true;
  });

  // Detect if user has manually scrolled up (want to disable auto-scroll)
  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = listElement;
      const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);

      // If user scrolled more than 100px from bottom, disable auto-scroll
      // If they scroll back to within 100px of bottom, re-enable
      autoScrollEnabled.current = distanceFromBottom < 100;
    };

    listElement.addEventListener("scroll", handleScroll);
    return () => listElement.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll to bottom on any content change (messages, streaming, tool calls)
  // useLayoutEffect runs before paint, preventing visible jump
  useLayoutEffect(() => {
    const listElement = listRef.current;
    if (!listElement || !autoScrollEnabled.current) return;

    const currentScrollHeight = listElement.scrollHeight;

    // Only scroll if content actually grew (new tokens, tool calls, etc)
    if (currentScrollHeight !== lastScrollHeight.current) {
      listElement.scrollTop = currentScrollHeight;
      lastScrollHeight.current = currentScrollHeight;
    }
  }, [filteredMessages, activeRequest, isLoading]);

  // Also scroll on any re-render when streaming (covers thinking/tool updates)
  // This ensures we scroll even if messages array reference doesn't change
  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement || !autoScrollEnabled.current) return;

    // Check if any message is currently streaming
    const hasStreamingMessage = filteredMessages.some((m) => m.isStreaming);

    if (hasStreamingMessage) {
      // Use requestAnimationFrame for smooth scroll during rapid updates
      const scrollToBottom = () => {
        const currentScrollHeight = listElement.scrollHeight;
        if (currentScrollHeight !== lastScrollHeight.current) {
          listElement.scrollTop = currentScrollHeight;
          lastScrollHeight.current = currentScrollHeight;
        }
      };

      const rafId = requestAnimationFrame(scrollToBottom);
      return () => cancelAnimationFrame(rafId);
    }
  }); // No deps - runs on every render to catch streaming updates

  if (filteredMessages.length === 0 && !isLoading) {
    return (
      <div
        className="message-list message-list-empty"
        data-testid="message-list"
        onDragOver={
          onFilesDropped
            ? (e) => {
                e.preventDefault();
                if ([...e.dataTransfer.types].includes("Files")) {
                  e.dataTransfer.dropEffect = "copy";
                }
              }
            : undefined
        }
        onDrop={
          onFilesDropped
            ? (e) => {
                e.preventDefault();
                const { files } = e.dataTransfer;
                if (files?.length) {
                  onFilesDropped(Array.from(files));
                }
              }
            : undefined
        }
      >
        <WelcomeMessage />
      </div>
    );
  }

  return (
    <div
      className="message-list"
      ref={listRef}
      data-testid="message-list"
      onDragOver={
        onFilesDropped
          ? (e) => {
              e.preventDefault();
              if ([...e.dataTransfer.types].includes("Files")) {
                e.dataTransfer.dropEffect = "copy";
              }
            }
          : undefined
      }
      onDrop={
        onFilesDropped
          ? (e) => {
              e.preventDefault();
              const { files } = e.dataTransfer;
              if (files?.length) {
                onFilesDropped(Array.from(files));
              }
            }
          : undefined
      }
    >
      {filteredMessages.map((message) => (
        <MessageItem key={message.id} chatId={chatId} message={message} />
      ))}
      {activeRequest && (
        <div className="message-item">
          <div className="message-avatar-container">
            <div className="message-avatar-assistant">
              <svg
                width="16"
                height="16"
                viewBox="0 0 105 124"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M52.5 0L105 30V90L52.5 120L0 90V30L52.5 0Z"
                  fill="currentColor"
                />
              </svg>
            </div>
          </div>
          <div className="message-content">
            <PermissionCard />
          </div>
        </div>
      )}
      {isLoading && (
        <div className="loading-indicator">
          <div className="loading-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      )}
      {isSending && !filteredMessages.some((m) => m.isStreaming) && (
        <div className="message-item">
          <div className="message-avatar-container">
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
                  stroke="url(#papr-gradient-loading)"
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <defs>
                  <linearGradient
                    id="papr-gradient-loading"
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
          </div>
          <div className="message-content">
            <div className="agent-loading-indicator">
              <div className="loading-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};
