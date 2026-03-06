/**
 * OAuthSection - OAuth authentication UI for OpenAI and Claude
 */

import React, { useState } from "react";
import { useOAuth } from "../../hooks/useOAuth";
import "./SettingsView.css";

interface OAuthSectionProps {
  provider: "openai" | "anthropic";
  title: string;
  subscriptionName: string;
  apiKeyName: string;
  apiKeyHint: string;
}

export function OAuthSection({
  provider,
  title,
  subscriptionName,
  apiKeyName,
  apiKeyHint,
}: OAuthSectionProps) {
  const { status, loading, startOAuthLogin, disconnect } = useOAuth(provider);
  const [useApiKey, setUseApiKey] = useState(false);

  const formatExpiry = (expiresAt?: string) => {
    if (!expiresAt) return "";
    const date = new Date(expiresAt);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 0) return "Expired";
    if (diffMins < 60) return `Expires in ${diffMins}m`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `Expires in ${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    return `Expires in ${diffDays}d`;
  };

  return (
    <div className="oauth-card">
      <div className="oauth-card__header">
        <h3>{title}</h3>
        {status.connected && (
          <span className="oauth-badge oauth-badge--connected">
            ✓ Connected
          </span>
        )}
      </div>

      {!useApiKey ? (
        <>
          {status.connected ? (
            <div className="oauth-connected-info">
              {status.accountId && (
                <div className="oauth-detail">
                  <span className="oauth-detail-label">Account:</span>
                  <span className="oauth-detail-value">
                    {status.accountId.substring(0, 16)}...
                  </span>
                </div>
              )}
              {status.expiresAt && (
                <div className="oauth-detail">
                  <span className="oauth-detail-label">Token:</span>
                  <span className="oauth-detail-value">
                    {formatExpiry(status.expiresAt)}
                  </span>
                </div>
              )}
              <button
                className="settings-btn settings-btn--secondary"
                onClick={disconnect}
                disabled={loading}
              >
                {loading ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          ) : (
            <>
              <p className="oauth-card__description">
                Use your {subscriptionName} subscription
              </p>
              <button
                className="settings-btn settings-btn--primary"
                onClick={startOAuthLogin}
                disabled={loading}
              >
                {loading ? "Connecting..." : `Sign in with ${title}`}
              </button>
            </>
          )}

        </>
      ) : (
        <>
          <div className="oauth-api-key-info">
            <p>Configure <code>{apiKeyName}</code> in the API Keys section below</p>
          </div>
        </>
      )}

      {/* Toggle Switch */}
      <div className="oauth-toggle-container">
        <span className={`oauth-toggle-label ${!useApiKey ? 'active' : ''}`}>
          OAuth
        </span>
        <button
          className="oauth-toggle-switch"
          onClick={() => setUseApiKey(!useApiKey)}
          aria-label="Toggle between OAuth and API Key"
        >
          <span className={`oauth-toggle-slider ${useApiKey ? 'right' : 'left'}`} />
        </button>
        <span className={`oauth-toggle-label ${useApiKey ? 'active' : ''}`}>
          API Key
        </span>
      </div>

      {status.error && (
        <div className="oauth-error">Error: {status.error}</div>
      )}
    </div>
  );
}
