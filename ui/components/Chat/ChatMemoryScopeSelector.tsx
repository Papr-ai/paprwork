/**
 * Per-chat memory sharing control.
 * Shares derived memories — not the raw chat transcript.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { useChatStore } from "../../stores/chatStore";
import {
  MEMORY_AUDIENCE_LABELS,
  MEMORY_SCOPE_EXPLAINER,
  type MemoryAudience,
} from "../../constants/memoryScope";
import "./ChatMemoryScopeSelector.css";

interface ChatMemoryScopeSelectorProps {
  chatId: string;
  compact?: boolean;
}

export function ChatMemoryScopeSelector({
  chatId,
  compact = false,
}: ChatMemoryScopeSelectorProps) {
  const scope = useChatStore(
    (state) =>
      state.memoryScopeByChatId.get(chatId) ??
      state.chats.find((item) => item.id === chatId)?.memoryScope ??
      "user",
  );
  const setChatMemoryScope = useChatStore((state) => state.setChatMemoryScope);
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  const applyScope = useCallback(
    async (nextScope: MemoryAudience) => {
      if (nextScope === scope) {
        setMenuOpen(false);
        return;
      }

      const previousScope = scope;
      setChatMemoryScope(chatId, nextScope);
      setSaving(true);

      if (chatId.startsWith("temp-")) {
        setSaving(false);
        setMenuOpen(false);
        return;
      }

      try {
        await gateway.send("chat:update", {
          chatId,
          memoryScope: nextScope,
        });
      } catch (error) {
        console.error("[ChatMemoryScopeSelector] Failed to update scope:", error);
        setChatMemoryScope(chatId, previousScope);
      } finally {
        setSaving(false);
        setMenuOpen(false);
      }
    },
    [chatId, scope, setChatMemoryScope],
  );

  const label = MEMORY_AUDIENCE_LABELS[scope];

  if (compact) {
    return (
      <div
        ref={rootRef}
        className="chat-memory-scope chat-memory-scope--compact"
        title={`${label.description}. ${MEMORY_SCOPE_EXPLAINER}`}
      >
        <button
          type="button"
          className="chat-memory-scope__trigger"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setMenuOpen((open) => !open)}
          disabled={saving}
          aria-label="Memory sharing for this chat"
          aria-expanded={menuOpen}
        >
          <span className="chat-memory-scope__trigger-prefix">Scope:</span>
          <span className="chat-memory-scope__trigger-value">{label.label}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {menuOpen && (
          <div className="chat-memory-scope__menu" role="menu">
            <p className="chat-memory-scope__menu-note">{MEMORY_SCOPE_EXPLAINER}</p>
            {(Object.keys(MEMORY_AUDIENCE_LABELS) as MemoryAudience[]).map(
              (audience) => {
                const option = MEMORY_AUDIENCE_LABELS[audience];
                const selected = audience === scope;
                return (
                  <button
                    key={audience}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`chat-memory-scope__option${selected ? " chat-memory-scope__option--selected" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void applyScope(audience)}
                  >
                    <span className="chat-memory-scope__option-label">
                      {option.label}
                    </span>
                    <span className="chat-memory-scope__option-hint">
                      {option.optionHint}
                    </span>
                  </button>
                );
              },
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="chat-memory-scope" title={label.description}>
      <span className="chat-memory-scope__label">Memories from this chat</span>
      <select
        className="chat-memory-scope__select"
        value={scope}
        onChange={(event) => void applyScope(event.target.value as MemoryAudience)}
        disabled={saving}
        aria-label="Memory sharing for this chat"
      >
        {(Object.keys(MEMORY_AUDIENCE_LABELS) as MemoryAudience[]).map(
          (audience) => (
            <option key={audience} value={audience}>
              {MEMORY_AUDIENCE_LABELS[audience].label}
            </option>
          ),
        )}
      </select>
      <p className="chat-memory-scope__footnote">{MEMORY_SCOPE_EXPLAINER}</p>
    </div>
  );
}
