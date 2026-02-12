/**
 * NewChatButton - Button to create a new chat
 */

import React from "react";
import "./NewChatButton.css";

interface NewChatButtonProps {
  onClick: () => void;
}

export function NewChatButton({ onClick }: NewChatButtonProps) {
  return (
    <button className="new-chat-button" onClick={onClick}>
      <svg
        className="new-chat-button__icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path
          d="M2 8H14M8 2V14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="new-chat-button__label">New Note</span>
    </button>
  );
}
