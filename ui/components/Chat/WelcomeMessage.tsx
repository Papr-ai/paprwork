/**
 * WelcomeMessage - Initial chat greeting with actionable starter buttons
 * Buttons dispatch papr-onboarding-send to auto-fill and send the chat input.
 */

import React, { useCallback } from "react";
import "./WelcomeMessage.css";

const STARTERS = [
  {
    label: "Build a social post generator",
    prompt: "Build me a social media post generator app with a backend agent job. The job should take a topic and generate posts for LinkedIn, Twitter, and a blog. The app should show the generated posts and let me edit them before copying. Ask me what topics I usually post about.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <path d="M17.5 14v7M14 17.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Create a daily briefing dashboard",
    prompt: "Build me a personal daily briefing app with a scheduled agent job. The job should run each morning, pull news and updates relevant to my work, summarize them, and write results to a database. The app should show today's briefing in a clean dashboard. Ask me what topics and sources matter most to me.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 9h18M9 21V9" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    label: "Research and write a report",
    prompt: "I need to research a topic and produce a thorough written report. Search the web, find credible sources, synthesize the findings, and create a document with the full analysis. Ask me what topic I need researched.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Set up a competitor tracker",
    prompt: "Build me a competitor tracking app with a scheduled agent job. The job should monitor competitor websites and news on a daily schedule, detect changes and announcements, and store findings in a database. The app should show a dashboard of recent competitor activity with highlights. Ask me which competitors to track.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.5" />
        <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
          What would you like to build?
        </h2>
        <p className="welcome-message__subtitle">
          Describe any workflow and Papr will build an app with an agent that automates it.
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
