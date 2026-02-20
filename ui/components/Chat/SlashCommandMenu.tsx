/**
 * SlashCommandMenu - Popup menu triggered by "/" in InputBar
 *
 * Commands:
 *   /new       - create new chat tab
 *   /export    - export conversation (JSON + Markdown)
 *   /summarize - trigger summary fetch
 *   /context   - show token/message count
 *   /help      - list commands
 *   /settings  - open settings tab
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import "./SlashCommandMenu.css";

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon: string;
}

const ALL_COMMANDS: SlashCommand[] = [
  { id: "new", label: "/new", description: "Create a new chat", icon: "+" },
  {
    id: "export",
    label: "/export",
    description: "Export this conversation",
    icon: "↓",
  },
  {
    id: "summarize",
    label: "/summarize",
    description: "Summarize conversation",
    icon: "Σ",
  },
  {
    id: "context",
    label: "/context",
    description: "Show token & message count",
    icon: "#",
  },
  {
    id: "help",
    label: "/help",
    description: "Show available commands",
    icon: "?",
  },
  {
    id: "settings",
    label: "/settings",
    description: "Open settings",
    icon: "⚙",
  },
];

interface SlashCommandMenuProps {
  query: string; // the text after "/"
  onSelect: (commandId: string) => void;
  onClose: () => void;
}

export function SlashCommandMenu({
  query,
  onSelect,
  onClose,
}: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = ALL_COMMANDS.filter(
    (cmd) =>
      cmd.id.startsWith(query.toLowerCase()) ||
      cmd.label.includes(query.toLowerCase()),
  );

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex].id);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filtered, selectedIndex, onSelect, onClose]);

  const handleClick = useCallback(
    (id: string) => {
      onSelect(id);
    },
    [onSelect],
  );

  if (filtered.length === 0) return null;

  return (
    <div className="slash-command-menu" ref={menuRef}>
      {filtered.map((cmd, index) => (
        <button
          key={cmd.id}
          className={`slash-command-item${index === selectedIndex ? " slash-command-item--active" : ""}`}
          onClick={() => handleClick(cmd.id)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className="slash-command-icon">{cmd.icon}</span>
          <div className="slash-command-content">
            <span className="slash-command-label">{cmd.label}</span>
            <span className="slash-command-desc">{cmd.description}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
