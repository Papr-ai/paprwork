/**
 * ChatGPTConvHistoryView - View ChatGPT conversation history
 * Test page for fetching and displaying user's ChatGPT conversations
 */

import React, { useState, useEffect } from "react";
import { gateway } from "../../src/lib/gateway";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { parseChatGPTConversation, type ParsedChatGPTMessage } from "../../utils/chatgptParser";
import "./ChatGPTConvHistoryView.css";

interface ChatGPTConversation {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
  model_slug?: string;
  is_archived: boolean;
}

interface ChatGPTConversationsResponse {
  items: ChatGPTConversation[];
  total: number;
  limit: number;
  offset: number;
  has_next?: boolean;
}

export function ChatGPTConvHistoryView() {
  const { status } = useAuthStatus();
  const [conversations, setConversations] = useState<ChatGPTConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(28);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [conversationDetails, setConversationDetails] = useState<unknown>(null);
  const [parsedMessages, setParsedMessages] = useState<ParsedChatGPTMessage[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const hasOAuth = status.openai.oauth;

  async function fetchConversations() {
    if (!hasOAuth) {
      setError("OpenAI OAuth not connected. Connect your ChatGPT account in Settings.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = (await gateway.send("chatgpt:list-conversations", {
        limit,
        offset,
        order: "updated", // 'updated' or 'created' (descending by default)
        isArchived: false,
        isStarred: false,
      })) as { success: boolean; data?: ChatGPTConversationsResponse; error?: string };

      if (response.success && response.data) {
        console.log("[ChatGPT] Sample conversation data:", response.data.items[0]);
        setConversations(response.data.items);
        setTotal(response.data.total);
      } else {
        setError(response.error || "Failed to fetch conversations");
      }
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Unknown error occurred";
      setError(errorMsg);
      console.error("Error fetching conversations:", err);
    } finally {
      setLoading(false);
    }
  }

  function formatDate(timestamp: number): string {
    if (!timestamp || isNaN(timestamp)) {
      return "Unknown";
    }
    
    // Try both formats: timestamp could be in seconds or milliseconds
    // If timestamp is less than a reasonable year 2000 timestamp in milliseconds,
    // it's probably in seconds
    const date = timestamp < 10000000000 
      ? new Date(timestamp * 1000) 
      : new Date(timestamp);
    
    if (isNaN(date.getTime())) {
      return "Invalid Date";
    }
    
    return date.toLocaleString();
  }

  function handlePrevPage() {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit));
    }
  }

  function handleNextPage() {
    if (offset + limit < total) {
      setOffset(offset + limit);
    }
  }

  // Fetch when offset changes
  useEffect(() => {
    if (hasOAuth && conversations.length === 0 && offset === 0) {
      // Auto-fetch on first load
      fetchConversations();
    }
  }, [hasOAuth, offset]);

  async function handleConversationClick(conversationId: string) {
    setSelectedConversation(conversationId);
    setLoadingDetails(true);
    setConversationDetails(null);

    try {
      const response = (await gateway.send("chatgpt:get-conversation", {
        conversationId,
      })) as { success: boolean; data?: unknown; error?: string };

      if (response.success && response.data) {
        console.log("[ChatGPT] Full conversation data:", response.data);
        setConversationDetails(response.data);
        
        // Parse messages for display
        const messages = parseChatGPTConversation(response.data);
        console.log("[ChatGPT] Parsed messages:", messages);
        setParsedMessages(messages);
      } else {
        setError(response.error || "Failed to fetch conversation details");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error occurred";
      setError(errorMsg);
      console.error("Error fetching conversation details:", err);
    } finally {
      setLoadingDetails(false);
    }
  }

  function closeConversationDetails() {
    setSelectedConversation(null);
    setConversationDetails(null);
    setParsedMessages([]);
  }

  function formatTimestamp(timestamp: number): string {
    if (!timestamp) return "";
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className="chatgpt-conv-history">
      <div className="chatgpt-conv-history__header">
        <h1>ChatGPT Conversation History</h1>
        <p className="chatgpt-conv-history__subtitle">
          View and import your conversations from ChatGPT
        </p>
      </div>

      {!hasOAuth && (
        <div className="chatgpt-conv-history__warning">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div>
            <strong>OpenAI OAuth not connected</strong>
            <p>Connect your ChatGPT account in Settings → API Keys to view your conversation history.</p>
          </div>
        </div>
      )}

      {hasOAuth && (
        <div className="chatgpt-conv-history__controls">
          <button
            className="chatgpt-conv-history__fetch-btn"
            onClick={fetchConversations}
            disabled={loading}
          >
            {loading ? "Loading..." : "Fetch Conversations"}
          </button>

          {total > 0 && (
            <div className="chatgpt-conv-history__pagination">
              <span>
                Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
              </span>
              <div className="chatgpt-conv-history__pagination-btns">
                <button onClick={handlePrevPage} disabled={offset === 0}>
                  Previous
                </button>
                <button onClick={handleNextPage} disabled={offset + limit >= total}>
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="chatgpt-conv-history__error">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <div>
            <strong>Error</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="chatgpt-conv-history__loading">
          <div className="chatgpt-conv-history__spinner" />
          <p>Loading conversations...</p>
        </div>
      )}

      {!loading && conversations.length > 0 && (
        <div className="chatgpt-conv-history__list">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className="chatgpt-conv-history__item"
              onClick={() => handleConversationClick(conv.id)}
              style={{ cursor: "pointer" }}
            >
              <div className="chatgpt-conv-history__item-header">
                <h3>{conv.title || "Untitled Conversation"}</h3>
                {conv.model_slug && (
                  <span className="chatgpt-conv-history__model-badge">
                    {conv.model_slug}
                  </span>
                )}
              </div>
              <div className="chatgpt-conv-history__item-meta">
                <span>
                  <strong>ID:</strong> {conv.id}
                </span>
                <span>
                  <strong>Created:</strong> {formatDate(conv.create_time)}
                </span>
                <span>
                  <strong>Updated:</strong> {formatDate(conv.update_time)}
                </span>
              </div>
              {conv.is_archived && (
                <span className="chatgpt-conv-history__archived-badge">
                  Archived
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && conversations.length === 0 && hasOAuth && !error && (
        <div className="chatgpt-conv-history__empty">
          <p>No conversations found. Click "Fetch Conversations" to load your ChatGPT history.</p>
        </div>
      )}

      {/* Conversation Details Modal */}
      {selectedConversation && (
        <div className="chatgpt-conv-history__modal" onClick={closeConversationDetails}>
          <div className="chatgpt-conv-history__modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="chatgpt-conv-history__modal-header">
              <h2>Conversation Details</h2>
              <button onClick={closeConversationDetails} className="chatgpt-conv-history__close-btn">
                ×
              </button>
            </div>
            <div className="chatgpt-conv-history__modal-body">
              {loadingDetails && (
                <div className="chatgpt-conv-history__loading">
                  <div className="chatgpt-conv-history__spinner" />
                  <p>Loading conversation...</p>
                </div>
              )}
              {!loadingDetails && conversationDetails && (
                <div className="chatgpt-conv-history__details">
                  {parsedMessages.length > 0 ? (
                    <div className="chatgpt-messages">
                      {parsedMessages.map((msg) => (
                        <div key={msg.id} className={`chatgpt-message chatgpt-message--${msg.role}`}>
                          <div className="chatgpt-message__header">
                            <span className="chatgpt-message__role">
                              {msg.role === "user" ? "👤 You" : msg.role === "assistant" ? "🤖 Assistant" : "⚙️ System"}
                            </span>
                            {msg.metadata.model && (
                              <span className="chatgpt-message__model">{msg.metadata.model}</span>
                            )}
                            {msg.timestamp > 0 && (
                              <span className="chatgpt-message__time">{formatTimestamp(msg.timestamp)}</span>
                            )}
                          </div>

                          {/* Metadata badges */}
                          <div className="chatgpt-message__badges">
                            {msg.metadata.thinkingEffort && (
                              <span className="chatgpt-badge chatgpt-badge--thinking">
                                💭 {msg.metadata.thinkingEffort} thinking
                              </span>
                            )}
                            {msg.metadata.tokenCount && (
                              <span className="chatgpt-badge chatgpt-badge--tokens">
                                🎫 {msg.metadata.tokenCount} tokens
                              </span>
                            )}
                            {msg.metadata.searchResults && msg.metadata.searchResults.length > 0 && (
                              <span className="chatgpt-badge chatgpt-badge--search">
                                🔍 Searched web
                              </span>
                            )}
                            {msg.metadata.citations && msg.metadata.citations.length > 0 && (
                              <span className="chatgpt-badge chatgpt-badge--citations">
                                📎 {msg.metadata.citations.length} sources
                              </span>
                            )}
                            {msg.metadata.finishReason === "length" && (
                              <span className="chatgpt-badge chatgpt-badge--truncated">
                                ✂️ Truncated
                              </span>
                            )}
                          </div>

                          {/* Message content */}
                          {msg.content && (
                            <div className="chatgpt-message__content">
                              {msg.content}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="chatgpt-conv-history__details-hint">
                      No messages found in this conversation.
                    </p>
                  )}

                  <details className="chatgpt-conv-history__raw-data">
                    <summary>View Raw JSON</summary>
                    <pre className="chatgpt-conv-history__json">
                      {JSON.stringify(conversationDetails, null, 2)}
                    </pre>
                  </details>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
