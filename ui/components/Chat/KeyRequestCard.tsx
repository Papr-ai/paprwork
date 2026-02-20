/**
 * Key Request Card
 *
 * Inline card that appears in chat when agent requests an API key.
 * User can enter the key value directly without leaving the conversation.
 */

import React, { useState } from "react";
import "./KeyRequestCard.css";

export interface KeyRequestData {
  type: "key_request";
  name: string;
  description: string;
  sourceUrl?: string;
  requiredScopes?: string[];
  suggestedPermission: "always" | "ask";
  status: "awaiting_user_input" | "submitted" | "cancelled";
  message: string;
}

interface Props {
  data: KeyRequestData;
  onSubmit: (
    keyName: string,
    keyValue: string,
    permission: "always" | "ask",
  ) => void;
  onCancel: () => void;
}

export function KeyRequestCard({ data, onSubmit, onCancel }: Props) {
  const [keyValue, setKeyValue] = useState("");
  const [permission, setPermission] = useState<"always" | "ask">(
    data.suggestedPermission,
  );
  const [showValue, setShowValue] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!keyValue.trim()) {
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(data.name, keyValue.trim(), permission);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setKeyValue("");
    onCancel();
  };

  if (data.status === "submitted") {
    return (
      <div className="key-request-card key-request-card-success">
        <div className="key-request-icon">✓</div>
        <div className="key-request-content">
          <h3 className="key-request-title">Key Added Successfully</h3>
          <p className="key-request-description">
            {data.name} has been securely stored and is ready to use.
          </p>
        </div>
      </div>
    );
  }

  if (data.status === "cancelled") {
    return (
      <div className="key-request-card key-request-card-cancelled">
        <div className="key-request-icon">✕</div>
        <div className="key-request-content">
          <h3 className="key-request-title">Request Cancelled</h3>
          <p className="key-request-description">
            You can add {data.name} later in Settings → API Keys.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="key-request-card">
      <div className="key-request-icon">🔑</div>

      <div className="key-request-content">
        <h3 className="key-request-title">API Key Required</h3>
        <p className="key-request-description">{data.description}</p>

        {data.sourceUrl && (
          <div className="key-request-source">
            <span className="key-request-label">Get key from:</span>
            <a
              href={`https://${data.sourceUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="key-request-link"
            >
              {data.sourceUrl}
            </a>
          </div>
        )}

        {data.requiredScopes && data.requiredScopes.length > 0 && (
          <div className="key-request-scopes">
            <span className="key-request-label">Required permissions:</span>
            <div className="key-request-scopes-list">
              {data.requiredScopes.map((scope) => (
                <code key={scope} className="key-request-scope">
                  {scope}
                </code>
              ))}
            </div>
          </div>
        )}

        <div className="key-request-input-group">
          <label
            htmlFor={`key-input-${data.name}`}
            className="key-request-label"
          >
            {data.name}
          </label>
          <div className="key-request-input-wrapper">
            <input
              id={`key-input-${data.name}`}
              type={showValue ? "text" : "password"}
              className="key-request-input"
              placeholder="Enter your API key"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              disabled={isSubmitting}
              autoFocus
            />
            <button
              type="button"
              className="key-request-toggle-visibility"
              onClick={() => setShowValue(!showValue)}
              aria-label={showValue ? "Hide key" : "Show key"}
            >
              {showValue ? "👁️" : "👁️‍🗨️"}
            </button>
          </div>
        </div>

        <div className="key-request-permission">
          <label className="key-request-checkbox">
            <input
              type="radio"
              name={`permission-${data.name}`}
              checked={permission === "always"}
              onChange={() => setPermission("always")}
              disabled={isSubmitting}
            />
            <span>Always allow (for automation)</span>
          </label>
          <label className="key-request-checkbox">
            <input
              type="radio"
              name={`permission-${data.name}`}
              checked={permission === "ask"}
              onChange={() => setPermission("ask")}
              disabled={isSubmitting}
            />
            <span>Ask each time (more secure)</span>
          </label>
        </div>
      </div>

      <div className="key-request-actions">
        <button
          className="btn btn-secondary"
          onClick={handleCancel}
          disabled={isSubmitting}
        >
          Cancel
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={!keyValue.trim() || isSubmitting}
        >
          {isSubmitting ? "Adding..." : "Add Key"}
        </button>
      </div>

      <div className="key-request-security-note">
        🔒 Your key will be encrypted and stored securely in your system
        keychain
      </div>
    </div>
  );
}
