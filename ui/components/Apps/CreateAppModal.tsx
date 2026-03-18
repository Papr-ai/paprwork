/**
 * CreateAppModal - Modal dialog for creating new apps via agent
 * Collects name + description, then opens a new chat with a pre-filled prompt
 */

import React, { useState, useRef, useEffect } from "react";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import { useChatStore } from "../../stores/chatStore";
import "./CreateAppModal.css";

interface CreateAppModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateAppModal({ isOpen, onClose }: CreateAppModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();

  useEffect(() => {
    if (isOpen) {
      setName("");
      setDescription("");
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const trimmedDesc = description.trim();
    let draftMessage = `Create a mini-app called "${trimmedName}"`;
    if (trimmedDesc) {
      draftMessage += `. Description: ${trimmedDesc}`;
    }

    const chatId = await createChat();
    if (chatId) {
      const tabId = createTab("chat", chatId, "New Chat");
      useChatStore.getState().setDraftMessage(chatId, draftMessage);
      switchToTab(tabId);
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="create-app-modal__backdrop" onClick={onClose}>
      <div
        className="create-app-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="create-app-modal__title">Create New App</h3>
        <p className="create-app-modal__subtitle">
          Give your app a name and optional description. The AI agent will build
          it for you.
        </p>

        <div className="create-app-modal__fields">
          <label className="create-app-modal__label">
            App Name
            <input
              ref={nameInputRef}
              type="text"
              className="create-app-modal__input"
              placeholder="e.g. Expense Tracker"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) handleSubmit();
              }}
            />
          </label>

          <label className="create-app-modal__label">
            Description
            <span className="create-app-modal__optional">optional</span>
            <textarea
              className="create-app-modal__textarea"
              placeholder="What should this app do?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </label>
        </div>

        <div className="create-app-modal__actions">
          <button className="create-app-modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="create-app-modal__submit"
            onClick={() => void handleSubmit()}
            disabled={!name.trim()}
          >
            Create with AI
          </button>
        </div>
      </div>
    </div>
  );
}
