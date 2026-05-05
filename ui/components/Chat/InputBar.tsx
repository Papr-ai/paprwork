/**
 * InputBar Component - Message input with send button
 * Handles textarea auto-resize, keyboard shortcuts, context artifacts, and slash commands
 */

import React, {
  useState,
  useRef,
  KeyboardEvent,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";
import { CHAT_MODELS, getModelGroups, ollamaModelFitsHostRam } from "../../constants/models";
import type { AIModel } from "../../constants/models";
import { ChatHistoryDropdown } from "./ChatHistoryDropdown";
import { ContextDropdown } from "./ContextDropdown";
import { ContextPills } from "./ContextPills";
import { SlashCommandMenu } from "./SlashCommandMenu";
import type { Artifact } from "../../stores/artifactsStore";
import { createFileContextArtifactsFromFiles } from "../../utils/fileContextArtifact";
import { useChatStore } from "../../stores/chatStore";
import { useOllama } from "../../hooks/useOllama";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import "./InputBar.css";

interface InputBarProps {
  chatId: string; // Chat ID for persisting draft messages
  onSend: (message: string, context?: Artifact[]) => void;
  onQueue?: (message: string, context?: Artifact[]) => void;
  /** Number of messages currently queued for this chat. */
  queuedCount?: number;
  onStop?: () => void;
  onSlashCommand?: (commandId: string) => void;
  isSending?: boolean;
  placeholder?: string;
  selectedModel?: AIModel;
  onModelChange?: (model: AIModel) => void;
  /** Returns true if user has API key or OAuth for this model */
  isModelAvailable?: (model: AIModel) => boolean;
  /** Called when user clicks a locked model - open settings to add key/OAuth */
  onOpenSettings?: () => void;
  /** Fires after file context pills are added (e.g. drag-drop) so parent can clear drag-over UI */
  onFileAttachmentsAdded?: () => void;
}

export interface InputBarRef {
  focus: () => void;
  /** Add dropped or pasted files as the same context attachments as "Attach file". */
  attachFiles: (files: File[]) => void;
}

export const InputBar = forwardRef<InputBarRef, InputBarProps>(
  (
    {
      chatId,
      onSend,
      onQueue,
      queuedCount = 0,
      onStop,
      onSlashCommand,
      isSending = false,
      placeholder = "Type a message...",
      selectedModel,
      onModelChange,
      isModelAvailable,
      onOpenSettings,
      onFileAttachmentsAdded,
    },
    ref,
  ) => {
    // Get draft message from store
    const draftMessage = useChatStore((state) => state.getDraftMessage(chatId));
    const setDraftMessage = useChatStore((state) => state.setDraftMessage);
    const clearDraftMessage = useChatStore((state) => state.clearDraftMessage);

    // Ollama status for showing install indicator
    const { hasModel, hostTotalRamGb } = useOllama();

    const [message, setMessage] = useState(draftMessage);
    const [isFocused, setIsFocused] = useState(false);
    const [showModelPicker, setShowModelPicker] = useState(false);
    const [showChatHistory, setShowChatHistory] = useState(false);
    const [showContextDropdown, setShowContextDropdown] = useState(false);
    const [showSlashMenu, setShowSlashMenu] = useState(false);
    const [slashQuery, setSlashQuery] = useState("");
    const [selectedArtifacts, setSelectedArtifacts] = useState<Artifact[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const inputBarRef = useRef<HTMLDivElement>(null);
    const lastSendAttemptRef = useRef<number>(0);

    // Use first model as default if none selected
    const currentModel = selectedModel || CHAT_MODELS[0];
    const modelGroups = getModelGroups();

    // Sync message state with store when chatId changes
    useEffect(() => {
      const draft = useChatStore.getState().getDraftMessage(chatId);
      setMessage(draft);
    }, [chatId]);

    // Debounced save to store - only saves 300ms after user stops typing
    const debouncedSaveDraft = useDebouncedCallback(
      (chatId: string, draft: string) => {
        setDraftMessage(chatId, draft);
      },
      300,
    );

    // Save draft message to store (debounced to avoid lag on every keystroke)
    useEffect(() => {
      debouncedSaveDraft(chatId, message);
    }, [message, chatId, debouncedSaveDraft]);

    const appendFileArtifacts = useCallback(
      (files: File[]) => {
        if (files.length === 0) return;
        const newArtifacts = createFileContextArtifactsFromFiles(files);
        setSelectedArtifacts((prev) => {
          const out = [...prev];
          for (const a of newArtifacts) {
            if (!out.some((x) => x.id === a.id)) out.push(a);
          }
          return out;
        });
        setIsFocused(true);
        onFileAttachmentsAdded?.();
        queueMicrotask(() => textareaRef.current?.focus());
      },
      [onFileAttachmentsAdded],
    );

    const handleFileDragOver = useCallback((e: React.DragEvent) => {
      if ([...e.dataTransfer.types].includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    }, []);

    const handleFileDrop = useCallback(
      (e: React.DragEvent) => {
        const { files } = e.dataTransfer;
        if (!files?.length) return;
        e.preventDefault();
        appendFileArtifacts(Array.from(files));
      },
      [appendFileArtifacts],
    );

    // Expose focus + file attach for drag-drop on parent (whole chat surface)
    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          textareaRef.current?.focus();
        },
        attachFiles: (files: File[]) => appendFileArtifacts(files),
      }),
      [appendFileArtifacts],
    );

    // Auto-focus on mount
    useEffect(() => {
      textareaRef.current?.focus();
    }, []);

    // Context artifact management
    const handleSelectArtifact = useCallback((artifact: Artifact) => {
      setSelectedArtifacts((prev) => {
        if (prev.some((a) => a.id === artifact.id)) return prev;
        return [...prev, artifact];
      });
      setShowContextDropdown(false);
    }, []);

    const handleRemoveArtifact = useCallback((id: string) => {
      setSelectedArtifacts((prev) => prev.filter((a) => a.id !== id));
    }, []);

    // Slash command selection
    const handleSlashSelect = useCallback(
      (commandId: string) => {
        setShowSlashMenu(false);
        setSlashQuery("");
        setMessage("");
        onSlashCommand?.(commandId);
      },
      [onSlashCommand],
    );

    const handleSend = () => {
      const trimmedMessage = message.trim();
      if (trimmedMessage) {
        const now = Date.now();
        const timeSinceLastAttempt = now - lastSendAttemptRef.current;
        
        // If agent is working
        if (isSending) {
          // If user pressed send again within 1 second (double-enter or double-click), 
          // stop agent and send immediately
          if (timeSinceLastAttempt < 1000) {
            if (onStop) {
              onStop();
            }
            onSend(
              trimmedMessage,
              selectedArtifacts.length > 0 ? selectedArtifacts : undefined,
            );
            setMessage("");
            clearDraftMessage(chatId);
            setSelectedArtifacts([]);
            
            if (textareaRef.current) {
              textareaRef.current.style.height = "auto";
            }
            lastSendAttemptRef.current = 0; // Reset
          } else {
            // First attempt while agent is working - queue the message
            if (onQueue) {
              onQueue(
                trimmedMessage,
                selectedArtifacts.length > 0 ? selectedArtifacts : undefined,
              );
            }
            setMessage("");
            clearDraftMessage(chatId);
            setSelectedArtifacts([]);
            
            if (textareaRef.current) {
              textareaRef.current.style.height = "auto";
            }
            lastSendAttemptRef.current = now;
          }
        } else {
          // Agent not working - send normally
          onSend(
            trimmedMessage,
            selectedArtifacts.length > 0 ? selectedArtifacts : undefined,
          );
          setMessage("");
          clearDraftMessage(chatId);
          setSelectedArtifacts([]);

          if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
          }
          lastSendAttemptRef.current = 0;
        }
      }
    };

    const handleStop = () => {
      if (onStop) {
        onStop();
      }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Let the slash command menu handle navigation keys
      if (
        showSlashMenu &&
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Tab")
      ) {
        return; // SlashCommandMenu handles these via window event
      }
      if (showSlashMenu && e.key === "Enter") {
        return; // Let SlashCommandMenu handle Enter
      }
      if (showSlashMenu && e.key === "Escape") {
        setShowSlashMenu(false);
        return;
      }

      // Send on Enter (without Shift)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Double-Enter shortcut: first Enter queued the message + cleared
        // the input. A second Enter on an empty input while the agent is
        // still working AND there is a queued message should stop the
        // agent. The existing processNextQueued effect in ChatContainer
        // automatically sends the queued message when isSending goes
        // false, so we only need to call onStop here.
        if (!message.trim() && isSending && queuedCount > 0 && onStop) {
          onStop();
          return;
        }
        handleSend();
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setMessage(value);

      // Detect slash commands: must start with "/" and have no spaces before the query
      if (value.startsWith("/") && !value.includes(" ")) {
        setSlashQuery(value.slice(1));
        setShowSlashMenu(true);
      } else {
        setShowSlashMenu(false);
        setSlashQuery("");
      }

      // Auto-resize textarea
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      }
    };

    // Handle blur - only hide if clicking outside the entire input bar
    const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
      // Check if the new focus target is within the input bar
      const relatedTarget = e.relatedTarget as Node | null;
      if (!relatedTarget || !inputBarRef.current?.contains(relatedTarget)) {
        setIsFocused(false);
        setShowModelPicker(false);
      }
    };

    return (
      <div
        className="input-bar"
        ref={inputBarRef}
        style={{ position: "relative" }}
      >
        {/* Slash command menu */}
        {showSlashMenu && (
          <SlashCommandMenu
            query={slashQuery}
            onSelect={handleSlashSelect}
            onClose={() => setShowSlashMenu(false)}
          />
        )}

        <div
          className="input-bar__wrapper"
          onDragOver={handleFileDragOver}
          onDrop={handleFileDrop}
        >
          {/* Context pills - shown when artifacts are selected */}
          {(isFocused || selectedArtifacts.length > 0) && (
            <div className="input-context-section">
              <ContextPills
                artifacts={selectedArtifacts}
                onRemove={handleRemoveArtifact}
                onAddClick={() => setShowContextDropdown(!showContextDropdown)}
              />
              <ContextDropdown
                isOpen={showContextDropdown}
                onClose={() => setShowContextDropdown(false)}
                onSelectArtifact={handleSelectArtifact}
                selectedIds={selectedArtifacts.map((a) => a.id)}
              />
            </div>
          )}

          {/* Input row */}
          <div className="input-row">
            <textarea
              ref={textareaRef}
              className="input-textarea"
              data-testid="chat-input"
              value={message}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={handleBlur}
              onDragOver={handleFileDragOver}
              onDrop={handleFileDrop}
              placeholder={placeholder}
              rows={1}
            />
          </div>

          {/* Footer - below textarea, shown when focused */}
          {isFocused && (
            <div className="input-footer">
              <div className="model-controls">
                <button
                  className="model-selector-pill"
                  title="Select model"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setShowModelPicker(!showModelPicker);
                  }}
                >
                  <span>{currentModel.name}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M6 9l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  className="chat-history-btn"
                  title="Chat history"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setShowChatHistory(!showChatHistory);
                    setShowModelPicker(false);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M12 6v6l4 2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>

                {/* Chat History Dropdown */}
                {showChatHistory && (
                  <ChatHistoryDropdown
                    onClose={() => setShowChatHistory(false)}
                  />
                )}

                {/* Model Picker Dropdown */}
                {showModelPicker && (
                  <div className="model-picker-dropdown">
                    {Object.entries(modelGroups).map(([groupName, models]) => (
                      <div key={groupName} className="model-picker-group">
                        <div className="model-picker-group-label">
                          {groupName}
                        </div>
                        {models.map((model) => {
                          const available = isModelAvailable?.(model) ?? true;
                          const isOllama = model.provider === 'ollama';
                          const needsInstall = isOllama && !hasModel(model.id);
                          const ramTight =
                            isOllama &&
                            hostTotalRamGb !== null &&
                            !ollamaModelFitsHostRam(model.id, hostTotalRamGb);
                          
                          return (
                            <button
                              key={model.id}
                              className={`model-picker-item ${currentModel.id === model.id ? "model-picker-item--selected" : ""} ${!available ? "model-picker-item--locked" : ""} ${needsInstall ? "model-picker-item--needs-install" : ""}`}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                if (available) {
                                  onModelChange?.(model);
                                  setShowModelPicker(false);
                                  textareaRef.current?.focus();
                                } else {
                                  onOpenSettings?.();
                                  setShowModelPicker(false);
                                }
                              }}
                              title={
                                !available
                                  ? "Add API key or connect OAuth in Settings"
                                  : ramTight
                                    ? `Estimated RAM needs may exceed this device (~${hostTotalRamGb} GB). Smaller Ollama models may run better.`
                                    : needsInstall
                                      ? "Click to download and install"
                                      : undefined
                              }
                            >
                              <div className="model-picker-item-content">
                                <div className="model-picker-item-name">
                                  {model.name}
                                  {!available && (
                                    <span
                                      className="model-badge-locked"
                                      title="Add API key or connect OAuth"
                                    >
                                      <svg
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                      </svg>
                                    </span>
                                  )}
                                  {ramTight && available && (
                                    <span
                                      className="model-badge-ram-warn"
                                      title="May need more RAM than this Mac/PC"
                                    >
                                      RAM
                                    </span>
                                  )}
                                  {needsInstall && available && (
                                    <span
                                      className="model-badge-install"
                                      title="Download required"
                                    >
                                      <svg
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                                      </svg>
                                    </span>
                                  )}
                                  {model.supportsThinking && available && (
                                    <span className="model-badge-thinking">
                                      thinking
                                    </span>
                                  )}
                                </div>
                                <div className="model-picker-item-desc">
                                  {model.description}
                                </div>
                              </div>
                              {currentModel.id === model.id && available && (
                                <svg
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                >
                                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                                </svg>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button
                className={`send-button ${isSending ? "send-button-stop" : message.trim() ? "send-button-active" : ""}`}
                data-testid={isSending ? "stop-button" : "send-button"}
                onClick={isSending ? handleStop : handleSend}
                disabled={!isSending && !message.trim()}
                type="button"
                aria-label={isSending ? "Stop agent" : "Send message"}
                title={
                  isSending
                    ? "Stop agent (or press Enter to stop & send new message)"
                    : "Send message"
                }
              >
                {isSending ? (
                  // Stop icon (square)
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                    <rect
                      x="5"
                      y="5"
                      width="10"
                      height="10"
                      fill="currentColor"
                      rx="1"
                    />
                  </svg>
                ) : (
                  // Send icon (paper plane)
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                    <path
                      d="M2.5 10L17.5 3.33333L10.8333 18.3333L9.16667 11.6667L2.5 10Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  },
);
