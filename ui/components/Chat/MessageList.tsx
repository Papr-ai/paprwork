/**
 * MessageList Component - Scrollable list of messages
 */

import React, { useLayoutEffect, useRef, useEffect, useMemo } from "react";
import { MessageItem } from "./MessageItem";
import { WelcomeMessage } from "./WelcomeMessage";
import { PermissionCard } from "./PermissionCard";
import { usePermissionStore } from "../../stores/permissionStore";
import { useChatStore } from "../../stores/chatStore";
import type { ChatMessage } from "../../stores/chatStore";
import { extractFilesFromDataTransfer } from "../../utils/chatAttachmentFiles";
import { isHiddenContinueUserMessage } from "../../lib/agentStreamRecovery";
import { groupDelegationFollowUpMessages } from "../../utils/delegationMessageGrouping";
import "./MessageList.css";

interface MessageListProps {
  chatId: string;
  messages: ChatMessage[];
  isLoading?: boolean;
  isSending?: boolean;
  isWaitingForAgentSlot?: boolean;
  /** When set, file drops on the list attach the same way as Add context → file upload */
  onFilesDropped?: (files: File[]) => void;
  /** Called when user scrolls to the top (for loading older messages) */
  onLoadOlder?: () => void;
}

/** Job auto-deliver placeholders — SubAgentResponseTrigger handles user-facing updates instead */
function isSubAgentDeliveryPlaceholder(content: string): boolean {
  return /^Agent job Delegation: .+ finished with no textual output\.$/.test(
    content.trim(),
  );
}

export const MessageList: React.FC<MessageListProps> = ({
  chatId,
  messages,
  isLoading,
  isSending,
  isWaitingForAgentSlot,
  onFilesDropped,
  onLoadOlder,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeRequest = usePermissionStore((s) => s.activeRequest);
  const autoScrollEnabled = useRef(true);
  const lastScrollHeight = useRef(0);
  const hasLoadedOnce = useRef(false);
  const previousMessageCount = useRef(messages.length);
  const scrollBottomBeforeLoad = useRef(0);
  
  // Get pagination state from chat store
  const chatState = useChatStore((state) => state.chatStates.get(chatId));
  const hasMoreMessages = chatState?.hasMoreMessages ?? false;
  const isLoadingMore = chatState?.isLoadingMore ?? false;

  // Filter out sub-agent trigger messages from main chat (they appear in MiniChatCard)
  const filteredMessages = messages.filter((msg) => {
    // Hide synthetic sub-agent user messages
    if (msg.role === "user" && isHiddenContinueUserMessage(msg.content)) {
      return false;
    }
    if (
      msg.role === "user" &&
      (msg.content.startsWith("[Sub-agent question for delegation ") ||
        msg.content.startsWith("[User message in sub-agent chat for delegation ") ||
        msg.content.startsWith("[Sub-agent delegation finished for "))
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
    if (
      msg.role === "assistant" &&
      isSubAgentDeliveryPlaceholder(msg.content)
    ) {
      return false;
    }
    return true;
  });

  const groupedMessages = useMemo(
    () => groupDelegationFollowUpMessages(filteredMessages),
    [filteredMessages],
  );

  // Detect scroll position for auto-scroll and load-more triggers
  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = listElement;
      const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);

      // If user scrolled more than 100px from bottom, disable auto-scroll
      // If they scroll back to within 100px of bottom, re-enable
      autoScrollEnabled.current = distanceFromBottom < 100;

      // Load older messages when user scrolls near the top (within 200px)
      if (scrollTop < 200 && hasMoreMessages && !isLoadingMore && onLoadOlder && hasLoadedOnce.current) {
        console.log("[MessageList] User scrolled near top, loading older messages...");
        onLoadOlder();
      }
    };

    listElement.addEventListener("scroll", handleScroll);
    return () => listElement.removeEventListener("scroll", handleScroll);
  }, [hasMoreMessages, isLoadingMore, onLoadOlder]);

  // Mark as loaded once messages appear (to avoid triggering on mount)
  useEffect(() => {
    if (messages.length > 0) {
      hasLoadedOnce.current = true;
    }
  }, [messages.length]);

  // Preserve scroll position when older messages are loaded (prepended to top)
  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;

    // If messages were added to the beginning (count increased), restore scroll position
    if (messages.length > previousMessageCount.current) {
      const addedCount = messages.length - previousMessageCount.current;
      // Only adjust scroll if we're not at the bottom (i.e., loading older messages)
      const distanceFromBottom = listElement.scrollHeight - (listElement.scrollTop + listElement.clientHeight);
      if (distanceFromBottom > 200) {
        // Calculate new scroll position to keep the same content visible
        const newScrollHeight = listElement.scrollHeight;
        const heightDiff = newScrollHeight - lastScrollHeight.current;
        listElement.scrollTop += heightDiff;
        lastScrollHeight.current = newScrollHeight;
      }
    }
    previousMessageCount.current = messages.length;
  }, [messages.length]);

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
                e.stopPropagation();
                const files = extractFilesFromDataTransfer(e.dataTransfer);
                if (files.length > 0) {
                  onFilesDropped(files);
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
              e.stopPropagation();
              const files = extractFilesFromDataTransfer(e.dataTransfer);
              if (files.length > 0) {
                onFilesDropped(files);
              }
            }
          : undefined
      }
    >
      {isLoadingMore && (
        <div className="loading-older-indicator">
          <div className="loading-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <span style={{ marginLeft: '8px', fontSize: '13px', color: 'var(--text-tertiary, #888)' }}>
            Loading older messages...
          </span>
        </div>
      )}
      {groupedMessages.map((message) => (
        <MessageItem
          key={message.id}
          chatId={chatId}
          message={message}
          delegationFollowUps={message.delegationFollowUps}
        />
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
      {isWaitingForAgentSlot &&
        isSending &&
        !filteredMessages.some((m) => m.isStreaming) && (
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
                  stroke="url(#papr-gradient-waiting)"
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <defs>
                  <linearGradient
                    id="papr-gradient-waiting"
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
            <div className="agent-waiting-indicator">
              <span className="agent-waiting-indicator__label">
                Waiting for agent slot…
              </span>
              <div className="loading-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        </div>
      )}
      {isSending &&
        !isWaitingForAgentSlot &&
        !filteredMessages.some((m) => m.isStreaming) && (
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
