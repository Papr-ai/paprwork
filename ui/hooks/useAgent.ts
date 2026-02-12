/**
 * useAgent Hook - Manage agent streaming and messages
 * Handles real-time streaming from the AI agent via WebSocket
 */

import { useCallback, useEffect, useRef } from "react";
import type { AgentConfig, StreamChunk } from "../types/core";
import { useChatStore } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";
import { gateway } from "../src/lib/gateway";

export function useAgent() {
  const {
    addMessage,
    updateStreamingMessage,
    finalizeStreamingMessage,
    setSending,
    setError,
  } = useChatStore();
  const streamingMessageIdRef = useRef<string | null>(null);
  const streamingContentRef = useRef<string>("");
  const streamingReasoningRef = useRef<string>("");
  const toolCallsMapRef = useRef<Map<string, any>>(new Map());
  const updateBatchRef = useRef<NodeJS.Timeout | null>(null);
  const pendingChatIdRef = useRef<string | null>(null);

  // Listen for Gateway connection changes
  useEffect(() => {
    const unsubscribe = gateway.onConnectionChange((connected) => {
      if (connected) {
        // Clear error when Gateway reconnects
        setError(null);
      } else {
        // Show error when Gateway disconnects
        setError("Gateway not connected");
      }
    });

    return unsubscribe;
  }, [setError]);

  // Handle streaming chunks
  const handleStreamChunk = useCallback(
    (chunk: StreamChunk) => {
      console.log("[useAgent] handleStreamChunk received:", chunk.type, chunk);

      // Extract chatId from chunk (all chunks should have this)
      const chatId = (chunk as any).chatId;
      
      if (!chatId) {
        console.error("[useAgent] Chunk missing chatId:", chunk);
        return;
      }

      // Ensure we have a streaming message for all chunk types
      if (!streamingMessageIdRef.current && chunk.type !== "done" && chunk.type !== "error") {
        const messageId = `msg-${Date.now()}`;
        streamingMessageIdRef.current = messageId;
        streamingContentRef.current = "";
        streamingReasoningRef.current = "";
        toolCallsMapRef.current = new Map();

        addMessage({
          id: messageId,
          role: "assistant",
          content: "",
          isStreaming: true,
          streamingContent: "",
          reasoning: "",
          streamingReasoning: "",
          toolCalls: [],
        }, chatId);
      }

      switch (chunk.type) {
        case "reasoning-delta":
          {
            // Append reasoning delta
            const chatId = (chunk as any).chatId;
            const text = (chunk.payload as { text: string }).text || "";
            streamingReasoningRef.current += text;
            
            // Update the message with new reasoning content directly in chatState
            const { chatStates } = useChatStore.getState();
            const chatState = chatStates.get(chatId);
            if (chatState) {
              const updatedMessages = chatState.messages.map((msg) =>
                msg.id === streamingMessageIdRef.current
                  ? {
                      ...msg,
                      streamingReasoning: streamingReasoningRef.current,
                    }
                  : msg
              );
              const newChatStates = new Map(chatStates);
              newChatStates.set(chatId, { ...chatState, messages: updatedMessages });
              useChatStore.setState({ chatStates: newChatStates });
            }
          }
          break;

        case "tool-call":
          {
            // Add or update tool call
            const chatId = (chunk as any).chatId;
            const payload = chunk.payload as { toolName: string; args?: Record<string, unknown>; toolCallId?: string };
            const toolCallId = payload.toolCallId || `tool-${Date.now()}-${payload.toolName}`;
            
            console.log(`[useAgent] Tool call: ${payload.toolName}`, payload.args);
            
            toolCallsMapRef.current.set(toolCallId, {
              id: toolCallId,
              toolName: payload.toolName,
              args: payload.args,
              status: "calling",
            });

            // Update the message with new tool calls directly in chatState
            const { chatStates } = useChatStore.getState();
            const chatState = chatStates.get(chatId);
            if (chatState) {
              const toolCallsArray = Array.from(toolCallsMapRef.current.values());
              console.log(`[useAgent] Updating UI with ${toolCallsArray.length} tool call(s):`, toolCallsArray);
              
              const updatedMessages = chatState.messages.map((msg) =>
                msg.id === streamingMessageIdRef.current
                  ? {
                      ...msg,
                      toolCalls: toolCallsArray,
                    }
                  : msg
              );
              const newChatStates = new Map(chatStates);
              newChatStates.set(chatId, { ...chatState, messages: updatedMessages });
              useChatStore.setState({ chatStates: newChatStates });
            }
          }
          break;

        case "tool-result":
          {
            // Update tool call with result
            const chatId = (chunk as any).chatId;
            const payload = chunk.payload as { toolCallId: string; result?: string; error?: string };
            const existingCall = toolCallsMapRef.current.get(payload.toolCallId);
            
            console.log(`[useAgent] Tool result for ${existingCall?.toolName || payload.toolCallId}:`, 
              payload.result ? (typeof payload.result === 'string' ? payload.result.substring(0, 100) : JSON.stringify(payload.result).substring(0, 100)) : 'no result');
            
            if (existingCall) {
              toolCallsMapRef.current.set(payload.toolCallId, {
                ...existingCall,
                status: payload.error ? "error" : "success",
                result: payload.result,
                error: payload.error,
              });

              // Update the message directly in chatState
              const { chatStates } = useChatStore.getState();
              const chatState = chatStates.get(chatId);
              if (chatState) {
                const toolCallsArray = Array.from(toolCallsMapRef.current.values());
                console.log(`[useAgent] Updating UI after tool result, ${toolCallsArray.length} tool call(s):`, 
                  toolCallsArray.map(tc => ({ name: tc.toolName, status: tc.status })));
                
                const updatedMessages = chatState.messages.map((msg) =>
                  msg.id === streamingMessageIdRef.current
                    ? {
                        ...msg,
                        toolCalls: toolCallsArray,
                      }
                    : msg
                );
                const newChatStates = new Map(chatStates);
                newChatStates.set(chatId, { ...chatState, messages: updatedMessages });
                useChatStore.setState({ chatStates: newChatStates });
              }
            }
          }
          break;

        case "text-delta":
          {
            // Append delta to streaming content
            const chatId = (chunk as any).chatId;
            const text = (chunk.payload as { text: string }).text || "";
            streamingContentRef.current += text;
            pendingChatIdRef.current = chatId;
            
            // Batch updates to avoid excessive re-renders (update every 50ms max)
            if (updateBatchRef.current) {
              clearTimeout(updateBatchRef.current);
            }
            updateBatchRef.current = setTimeout(() => {
              if (streamingMessageIdRef.current && pendingChatIdRef.current) {
                updateStreamingMessage(
                  streamingMessageIdRef.current,
                  streamingContentRef.current,
                  pendingChatIdRef.current,
                );
              }
              updateBatchRef.current = null;
            }, 50); // Update at most every 50ms (20 FPS)
          }
          break;

        case "done":
          {
            // Clear any pending batch update
            if (updateBatchRef.current) {
              clearTimeout(updateBatchRef.current);
              updateBatchRef.current = null;
            }
            
            // Flush final update immediately
            const chatId = (chunk as any).chatId;
            if (streamingMessageIdRef.current) {
              // One final update with the complete content
              updateStreamingMessage(
                streamingMessageIdRef.current,
                streamingContentRef.current,
                chatId,
              );
              
              // Then finalize
              finalizeStreamingMessage(streamingMessageIdRef.current, chatId);
              streamingMessageIdRef.current = null;
              streamingContentRef.current = "";
              streamingReasoningRef.current = "";
              toolCallsMapRef.current = new Map();
              pendingChatIdRef.current = null;
            }
            setSending(chatId, false);  // ✅ Per-chat isSending
            
            // Clear streaming status (blue dot) for THIS chat's tab
            const { setTabStreaming } = useTabStore.getState();
            setTabStreaming(`chat-${chatId}`, false);
          }
          break;

        case "error":
          {
            // Handle error
            const chatId = (chunk as any).chatId;
            const errorMsg =
              (chunk.payload as { error: string }).error || "Unknown error";
            console.error("[useAgent] Received error chunk:", errorMsg);
            console.error("[useAgent] Full chunk payload:", chunk.payload);
            setError(errorMsg);
            if (streamingMessageIdRef.current) {
              finalizeStreamingMessage(streamingMessageIdRef.current, chatId);
              streamingMessageIdRef.current = null;
              streamingContentRef.current = "";
              streamingReasoningRef.current = "";
              toolCallsMapRef.current = new Map();
            }
            setSending(chatId, false);  // ✅ Per-chat isSending
          }
          break;

        case "tool-error":
          {
            // Handle tool execution error (bash, filesystem, etc.)
            const chatId = (chunk as any).chatId;
            const toolName = (chunk.payload as any).toolName || "unknown";
            const toolCallId = (chunk.payload as any).toolCallId;
            const errorMsg = (chunk.payload as { error: string }).error || "Tool execution failed";
            
            console.error(`[useAgent] Tool error (${toolName}):`, errorMsg);
            
            // Update the tool call with the error result
            if (toolCallId && streamingMessageIdRef.current) {
              const toolCall = toolCallsMapRef.current.get(toolCallId);
              if (toolCall) {
                toolCallsMapRef.current.set(toolCallId, {
                  ...toolCall,
                  result: `❌ Error: ${errorMsg}`,
                  status: 'error' as const,
                });
                
                // Update the message's tool calls
                const { chatStates } = useChatStore.getState();
                const chatState = chatStates.get(chatId);
                if (chatState) {
                  const updatedMessages = chatState.messages.map((msg) =>
                    msg.id === streamingMessageIdRef.current
                      ? {
                          ...msg,
                          toolCalls: Array.from(toolCallsMapRef.current.values()),
                        }
                      : msg
                  );
                  const newChatStates = new Map(chatStates);
                  newChatStates.set(chatId, { ...chatState, messages: updatedMessages });
                  useChatStore.setState({ chatStates: newChatStates });
                }
              }
            }
          }
          break;
      }
    },
    [
      addMessage,
      updateStreamingMessage,
      finalizeStreamingMessage,
      setSending,
      setError,
    ],
  );

  // Send message to agent
  const sendMessage = useCallback(
    async (
      message: string,
      config: AgentConfig,
      chatId: string,  // ✅ Now passed explicitly, not derived from activeTab
    ): Promise<void> => {
      console.log("=".repeat(80));
      console.log("[useAgent.sendMessage] ========== START ==========");
      console.log("[useAgent.sendMessage] Message:", message);
      console.log("[useAgent.sendMessage] ChatId:", chatId);
      
      const { setTabStreaming, setTabUnread, updateTabTitle, updateTabId } = useTabStore.getState();
      
      const isFirstMessage = chatId.startsWith("temp-");
      let finalChatId = chatId; // Will be updated if temp
      const tabId = `chat-${chatId}`;
      
      console.log("[useAgent.sendMessage]   - Is first message:", isFirstMessage);
      console.log("=".repeat(80));
      
      try {
        // V1 APPROACH: Create permanent chat BEFORE streaming if temp
        if (isFirstMessage) {
          console.log("[useAgent] First message - creating permanent chat before streaming");
          const createResponse = await gateway.send("chat:create", {});
          const newChatId = (createResponse.data as any)?.chatId;
          
          if (!newChatId) {
            throw new Error("Failed to create chat - no chatId returned");
          }
          
          console.log(`[useAgent] Created permanent chat: ${newChatId}`);
          
          // Update tab ID synchronously (like V1)
          updateTabId(tabId, `chat-${newChatId}`);
          console.log(`[useAgent] Updated tab: ${tabId} → chat-${newChatId}`);
          
          finalChatId = newChatId; // Use permanent ID for streaming
        }
        
        // Set tab streaming status (blue dot) for THIS chat's tab
        setTabStreaming(`chat-${finalChatId}`, true);
        
        // Add user message immediately to THIS chat
        addMessage({
          id: `msg-user-${Date.now()}`,
          role: "user",
          content: message,
        }, finalChatId);
        console.log("[useAgent] User message added to store");

        // Reset streaming state
        streamingMessageIdRef.current = null;
        streamingContentRef.current = "";
        streamingReasoningRef.current = "";
        toolCallsMapRef.current = new Map();

        setSending(finalChatId, true);  // ✅ Per-chat isSending
        setError(null);
        console.log("[useAgent] State reset, about to call gateway.stream");

        // V1 APPROACH: Generate title in parallel with streaming (non-blocking)
        // Title generation happens in background while user sees streaming response
        if (isFirstMessage) {
          // Fire and forget - don't await
          gateway.send("agent:generate-title", {
            chatId: finalChatId,
            message,
          }).then((titleResponse) => {
            const title = (titleResponse.data as any)?.title || "New Chat";
            console.log("[useAgent] Generated title:", title);
            updateTabTitle(`chat-${finalChatId}`, title);
          }).catch((titleError) => {
            console.error("[useAgent] Failed to generate title:", titleError);
          });
        }

        // Stream message via WebSocket (with permanent chatId)
        await gateway.stream(
          "agent:stream",
          {
            chatId: finalChatId, // Always permanent at this point
            message,
            config,
          },
          (chunk) => handleStreamChunk(chunk as StreamChunk),
        );
        console.log("[useAgent] gateway.stream completed successfully");
        
        // Set tab unread status if not active (green dot)
        // The streaming status (blue dot) was already cleared by the "done" chunk
        const currentActiveTabId = useTabStore.getState().activeTabId;
        const newTabId = `chat-${finalChatId}`;
        if (currentActiveTabId !== newTabId) {
          setTabUnread(newTabId, true);
        }
        
      } catch (error) {
        // Log full error with stack trace for debugging
        console.error("[useAgent] sendMessage error:", error);
        if (error instanceof Error) {
          console.error("[useAgent] Stack trace:", error.stack);
        }
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setError(errorMessage);
        setSending(finalChatId, false);  // ✅ Per-chat isSending
        
        // Clear streaming status on error for THIS chat's tab
        setTabStreaming(`chat-${finalChatId}`, false);
      }
    },
    [addMessage, setSending, setError, handleStreamChunk],
  );

  // Get chat history
  const getHistory = useCallback(
    async (sessionId: string) => {
      try {
        const response = await gateway.send("agent:history", { chatId: sessionId });
        return response.data || [];
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setError(errorMessage);
        return [];
      }
    },
    [setError],
  );

  // Clear chat history
  const clearHistory = useCallback(
    async (sessionId: string) => {
      try {
        await gateway.send("agent:clear", { sessionId });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setError(errorMessage);
      }
    },
    [setError],
  );

  return {
    sendMessage,
    getHistory,
    clearHistory,
  };
}

// Explicitly export the type to help TypeScript
export type UseAgentReturn = {
  sendMessage: (message: string, config: AgentConfig, chatId: string) => Promise<void>;
  getHistory: (sessionId: string) => Promise<any>;
  clearHistory: (sessionId: string) => Promise<void>;
};
