/**
 * Key Request Card
 *
 * Inline card that appears in chat when agent requests an API key.
 * User can enter the key value directly without leaving the conversation.
 */

import { useState } from "react";
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
  const [localStatus, setLocalStatus] = useState<KeyRequestData["status"]>(data.status);

  const handleSubmit = async () => {
    console.log("[KeyRequestCard] handleSubmit called", {
      hasKeyValue: !!keyValue.trim(),
      keyName: data.name,
      permission,
    });

    if (!keyValue.trim()) {
      console.warn("[KeyRequestCard] No key value provided, aborting");
      return;
    }

    setIsSubmitting(true);
    try {
      console.log("[KeyRequestCard] Calling onSubmit...");
      await onSubmit(data.name, keyValue.trim(), permission);
      console.log("[KeyRequestCard] onSubmit completed successfully");
      // Update local status to show success immediately
      setLocalStatus("submitted");
    } catch (error) {
      console.error("[KeyRequestCard] onSubmit failed:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setKeyValue("");
    setLocalStatus("cancelled");
    onCancel();
  };

  // Use local status if it's been updated, otherwise use data.status
  const currentStatus = localStatus !== data.status ? localStatus : data.status;

  if (currentStatus === "submitted") {
    return (
      <div className="key-request-card key-request-card-success">
        <div className="key-request-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M20 6L9 17l-5-5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="key-request-content">
          <h3 className="key-request-title">Key Added Successfully</h3>
          <p className="key-request-description">
            {data.name} has been securely stored and is ready to use.
          </p>
        </div>
      </div>
    );
  }

  if (currentStatus === "cancelled") {
    return (
      <div className="key-request-card key-request-card-cancelled">
        <div className="key-request-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M18 6L6 18M6 6l12 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
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
      <div className="key-request-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <rect
            x="5"
            y="11"
            width="14"
            height="10"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M12 15v2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M7 11V7a5 5 0 0110 0v4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </div>

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
              {showValue ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <line
                    x1="1"
                    y1="1"
                    x2="23"
                    y2="23"
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
          onClick={(e) => {
            console.log("[KeyRequestCard] Button clicked!", {
              event: e,
              keyValue: keyValue.trim(),
              isSubmitting,
            });
            handleSubmit();
          }}
          disabled={!keyValue.trim() || isSubmitting}
          type="button"
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

/**
 * Parse key request data from request_key tool result
 * Similar to parsePlanFromToolResult and parseJobStatusFromToolResult
 */
export function parseKeyRequestFromToolResult(
  toolName: string,
  result: string | unknown,
): KeyRequestData | null {
  if (toolName !== "request_key") return null;

  try {
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    const data = parsed.data || parsed;

    if (data.type === "key_request") {
      return {
        type: "key_request",
        name: data.name,
        description: data.description,
        sourceUrl: data.sourceUrl,
        requiredScopes: data.requiredScopes,
        suggestedPermission: data.suggestedPermission || "ask",
        status: data.status || "awaiting_user_input",
        message: data.message || `Waiting for user to provide ${data.name}...`,
      };
    }
  } catch (e) {
    // Not a key request result
  }

  return null;
}
