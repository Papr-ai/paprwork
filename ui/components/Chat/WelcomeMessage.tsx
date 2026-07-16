/**
 * WelcomeMessage - Initial chat greeting with actionable starter buttons
 * Buttons dispatch papr-onboarding-send to auto-fill and send the chat input.
 */

import React, { useCallback } from "react";
import "./WelcomeMessage.css";

const STARTERS = [
  {
    label: "Build a productivity app",
    prompt: "Build me a useful productivity app — ask me one question about what would save me the most time, then create it.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    label: "Write a blog post about AI",
    prompt: "Help me write a blog post about AI. Ask me one question about the angle or audience, then draft it.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Find files on my computer",
    prompt: "Help me find files on my computer. What are you looking for?",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M22 12h-6l-2 3h-4l-2-3H2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Research a topic online",
    prompt: "I want to research a topic online. What topic should I look into?",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
        <line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
];

export function WelcomeMessage() {
  const handleClick = useCallback((prompt: string) => {
    window.dispatchEvent(
      new CustomEvent("papr-onboarding-send", {
        detail: { message: prompt },
      }),
    );
  }, []);

  return (
    <div className="welcome-message">
      <div className="welcome-message__content">
        <h2 className="welcome-message__title">
          Hey, I'm Pen! Your personal agent
        </h2>
        <p className="welcome-message__subtitle">
          What would you like help with today?
        </p>

        <div className="example-cards">
          {STARTERS.map((s) => (
            <button
              key={s.label}
              className="example-card"
              onClick={() => handleClick(s.prompt)}
            >
              <div className="card-icon">{s.icon}</div>
              <span className="card-text">{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
