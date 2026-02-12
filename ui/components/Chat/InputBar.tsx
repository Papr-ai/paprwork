/**
 * InputBar Component - Message input with send button
 * Handles textarea auto-resize and keyboard shortcuts
 */

import React, { useState, useRef, KeyboardEvent, useEffect, forwardRef, useImperativeHandle } from "react";
import { CHAT_MODELS, getModelGroups } from "../../constants/models";
import type { AIModel } from "../../constants/models";
import { ChatHistoryDropdown } from "./ChatHistoryDropdown";
import "./InputBar.css";

interface InputBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  selectedModel?: AIModel;
  onModelChange?: (model: AIModel) => void;
}

export interface InputBarRef {
  focus: () => void;
}

export const InputBar = forwardRef<InputBarRef, InputBarProps>(({
  onSend,
  disabled = false,
  placeholder = "Type a message...",
  selectedModel,
  onModelChange,
}, ref) => {
  const [message, setMessage] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);

  // Use first model as default if none selected
  const currentModel = selectedModel || CHAT_MODELS[0];
  const modelGroups = getModelGroups();

  // Expose focus method to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSend = () => {
    const trimmedMessage = message.trim();
    if (trimmedMessage && !disabled) {
      onSend(trimmedMessage);
      setMessage("");

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter (without Shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);

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
    if (
      !relatedTarget ||
      !inputBarRef.current?.contains(relatedTarget)
    ) {
      setIsFocused(false);
      setShowModelPicker(false);
    }
  };

  return (
    <div className="input-bar" ref={inputBarRef}>
      <div className="input-bar__wrapper">
        {/* Context section - above textarea, shown when focused */}
        {isFocused && (
          <div className="input-context-section">
            <button
              className="add-context-pill"
              title="Add context"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // TODO: Open context picker
                console.log("Add context clicked");
              }}
            >
              + Add context
            </button>
          </div>
        )}

        {/* Input row */}
        <div className="input-row">
          <textarea
            ref={textareaRef}
            className="input-textarea"
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={handleBlur}
            placeholder={placeholder}
            disabled={disabled}
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
                  console.log("Model picker clicked, current state:", showModelPicker);
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
                  setShowModelPicker(false); // Close model picker if open
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
                <ChatHistoryDropdown onClose={() => setShowChatHistory(false)} />
              )}

              {/* Model Picker Dropdown - inside model-controls for proper positioning */}
              {showModelPicker && (
                <div className="model-picker-dropdown">
            {Object.entries(modelGroups).map(([groupName, models]) => (
              <div key={groupName} className="model-picker-group">
                <div className="model-picker-group-label">{groupName}</div>
                {models.map((model) => (
                  <button
                    key={model.id}
                    className={`model-picker-item ${currentModel.id === model.id ? "model-picker-item--selected" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onModelChange?.(model);
                      setShowModelPicker(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <div className="model-picker-item-content">
                      <div className="model-picker-item-name">
                        {model.name}
                        {model.supportsThinking && (
                          <span className="model-badge-thinking">💭</span>
                        )}
                      </div>
                      <div className="model-picker-item-desc">
                        {model.description}
                      </div>
                    </div>
                    {currentModel.id === model.id && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            ))}
                </div>
              )}
            </div>
            <button
              className={`send-button ${message.trim() ? "send-button-active" : ""}`}
              onClick={handleSend}
              disabled={disabled || !message.trim()}
              type="button"
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path
                  d="M2.5 10L17.5 3.33333L10.8333 18.3333L9.16667 11.6667L2.5 10Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
