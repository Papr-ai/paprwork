/**
 * Shown in place of the welcome screen when a chat's history could not be
 * loaded.
 *
 * A failed load and an empty chat produce the same empty `messages` array, and
 * the welcome screen is a confident statement about the second. Rendering it
 * for the first tells a user whose conversation is sitting intact in SQLite
 * that it does not exist — which reads as data loss and sends them looking for
 * a backup.
 *
 * Reuses the welcome screen's layout classes so the pane keeps its shape; only
 * the claim changes.
 */

import "./WelcomeMessage.css";

interface HistoryUnavailableProps {
  onRetry?: () => void;
}

export function HistoryUnavailable({ onRetry }: HistoryUnavailableProps) {
  return (
    <div className="welcome-message">
      <div className="welcome-message__content">
        <h2 className="welcome-message__title">Could not load this chat</h2>
        {/*
          "Any earlier messages" rather than "your messages": when chat
          metadata is unavailable we cannot tell a conversation from a chat
          the user just created, and this sentence is true either way. A
          message that promises saved history to someone who has none is the
          same overclaim in the opposite direction.
        */}
        <p className="welcome-message__subtitle">
          The local gateway did not answer. Any earlier messages are still
          saved and will appear once it reconnects.
        </p>
        {onRetry ? (
          <div className="example-cards">
            <button className="example-card" onClick={onRetry}>
              <div className="card-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <span className="card-text">Try again</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
