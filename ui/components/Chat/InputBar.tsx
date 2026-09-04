/**
 * InputBar Component - Message input with send button
 * Handles textarea auto-resize, keyboard shortcuts, context artifacts, and slash commands
 */

import * as React from "react";
import {
  useState,
  useRef,
  KeyboardEvent,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";
import { CHAT_MODELS } from "../../constants/models";
import type { AIModel } from "../../constants/models";
import { ModelPickerDropdown } from "./ModelPickerDropdown";
import { ChatMemoryScopeSelector } from "./ChatMemoryScopeSelector";
import { ContextDropdown } from "./ContextDropdown";
import { ContextPills } from "./ContextPills";
import { SlashCommandMenu } from "./SlashCommandMenu";
import type { Artifact } from "../../stores/artifactsStore";
import {
  createArtifactsFromIncomingFiles,
  extractFilesFromDataTransfer,
} from "../../utils/chatAttachmentFiles";
import { useChatStore } from "../../stores/chatStore";
import { useOllama } from "../../hooks/useOllama";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
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
  /** Open Settings → model picker visibility section */
  onOpenSettingsModels?: () => void;
  /** Models pinned to the chat picker (from Settings) */
  pickerModels?: AIModel[];
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
      onOpenSettingsModels,
      onFileAttachmentsAdded,
      pickerModels,
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
    const [showContextDropdown, setShowContextDropdown] = useState(false);
    const [showSlashMenu, setShowSlashMenu] = useState(false);
    const [slashQuery, setSlashQuery] = useState("");
    const [selectedArtifacts, setSelectedArtifacts] = useState<Artifact[]>([]);
    const [isSavingAttachments, setIsSavingAttachments] = useState(false);
    const [attachmentError, setAttachmentError] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const inputBarRef = useRef<HTMLDivElement>(null);
    const modelSelectorBtnRef = useRef<HTMLButtonElement>(null);
    const contextAddBtnRef = useRef<HTMLButtonElement>(null);
    const modelPickerDropdownRef = useRef<HTMLDivElement>(null);
    const contextDropdownRef = useRef<HTMLDivElement>(null);
    const lastSendAttemptRef = useRef<number>(0);

    // Use first model as default if none selected
    const currentModel = selectedModel || CHAT_MODELS[0];
    const visiblePickerModels = pickerModels ?? [currentModel];

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
      async (files: File[]) => {
        if (files.length === 0) return;
        setIsSavingAttachments(true);
        setAttachmentError(null);
        try {
          const newArtifacts = await createArtifactsFromIncomingFiles(files, chatId);
          if (newArtifacts.length === 0) {
            setAttachmentError(
              "Could not attach file. Try again or check that Paprwork can access the file.",
            );
            return;
          }
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
        } finally {
          setIsSavingAttachments(false);
        }
      },
      [chatId, onFileAttachmentsAdded],
    );

    const handleFileDragOver = useCallback((e: React.DragEvent) => {
      if ([...e.dataTransfer.types].includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    }, []);

    const handleFileDrop = useCallback(
      (e: React.DragEvent) => {
        const files = extractFilesFromDataTransfer(e.dataTransfer);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        void appendFileArtifacts(files);
      },
      [appendFileArtifacts],
    );

    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = extractFilesFromDataTransfer(e.clipboardData);
        if (files.length === 0) return;
        e.preventDefault();
        void appendFileArtifacts(files);
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
        attachFiles: (files: File[]) => {
          void appendFileArtifacts(files);
        },
      }),
      [appendFileArtifacts],
    );

    // Auto-focus on mount
    useEffect(() => {
      textareaRef.current?.focus();
    }, []);

    useDismissOnOutsideClick(
      showModelPicker,
      () => setShowModelPicker(false),
      modelSelectorBtnRef,
      modelPickerDropdownRef,
    );

    useDismissOnOutsideClick(
      showContextDropdown,
      () => setShowContextDropdown(false),
      contextAddBtnRef,
      contextDropdownRef,
    );

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
      const hasAttachments = selectedArtifacts.length > 0;
      if (!trimmedMessage && !hasAttachments) return;

      const messageToSend =
        trimmedMessage ||
        (hasAttachments
          ? "Please review the attached file(s)."
          : "");
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
            messageToSend,
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
              messageToSend,
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
          messageToSend,
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
        setShowChatHistory(false);
        setShowContextDropdown(false);
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
              {attachmentError ? (
                <div className="input-context-section__error" role="alert">
                  {attachmentError}
                </div>
              ) : null}
              <ContextPills
                artifacts={selectedArtifacts}
                onRemove={handleRemoveArtifact}
                onAddClick={() => {
                  setShowModelPicker(false);
                  setShowChatHistory(false);
                  setShowContextDropdown(!showContextDropdown);
                }}
                addButtonRef={contextAddBtnRef}
              />
              <ContextDropdown
                chatId={chatId}
                isOpen={showContextDropdown}
                onClose={() => setShowContextDropdown(false)}
                onSelectArtifact={handleSelectArtifact}
                selectedIds={selectedArtifacts.map((a) => a.id)}
                dropdownRef={contextDropdownRef}
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
              onPaste={handlePaste}
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
                  ref={modelSelectorBtnRef}
                  type="button"
                  className="model-selector-pill"
                  title="Select model"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setShowModelPicker(!showModelPicker);
                    setShowChatHistory(false);
                    setShowContextDropdown(false);
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
                {/* Model Picker Dropdown */}
                {showModelPicker && (
                  <ModelPickerDropdown
                    dropdownRef={modelPickerDropdownRef}
                    currentModelId={currentModel.id}
                    pickerModels={visiblePickerModels}
                    isModelAvailable={isModelAvailable}
                    hasModel={hasModel}
                    hostTotalRamGb={hostTotalRamGb}
                    onSelect={(model) => {
                      onModelChange?.(model);
                      setShowModelPicker(false);
                      textareaRef.current?.focus();
                    }}
                    onOpenSettings={() => {
                      onOpenSettings?.();
                      setShowModelPicker(false);
                    }}
                    onOpenSettingsModels={() => {
                      onOpenSettingsModels?.();
                      setShowModelPicker(false);
                    }}
                  />
                )}
              </div>
              <div className="input-footer__actions">
                <ChatMemoryScopeSelector chatId={chatId} compact />
                <button
                  className={`send-button ${isSending ? "send-button-stop" : message.trim() || selectedArtifacts.length > 0 ? "send-button-active" : ""}`}
                  data-testid={isSending ? "stop-button" : "send-button"}
                  onClick={isSending ? handleStop : handleSend}
                  disabled={
                    isSavingAttachments ||
                    (!isSending && !message.trim() && selectedArtifacts.length === 0)
                  }
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
            </div>
          )}
        </div>
      </div>
    );
  },
);

InputBar.displayName = 'InputBar';
