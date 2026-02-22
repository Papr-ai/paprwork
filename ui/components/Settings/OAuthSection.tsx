/**
 * OAuthSection - OAuth authentication UI for OpenAI and Claude
 */

import React from "react";
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
    <div className="oauth-section">
      <div className="oauth-section__header">
        <h3 className="oauth-section__title">{title}</h3>
      </div>

      <div className="oauth-section__content">
        {/* OAuth Subscription Option */}
        <div className="oauth-option">
          <div className="oauth-option__header">
            <div className="oauth-option__radio">
              <input
                type="radio"
                name={`${provider}-auth-method`}
                checked={status.connected}
                readOnly
              />
              <label>{subscriptionName} (OAuth)</label>
            </div>
            {status.connected && !status.isExpired && (
              <span className="oauth-status oauth-status--connected">
                ✓ Connected
              </span>
            )}
            {status.connected && status.isExpired && (
              <span className="oauth-status oauth-status--expired">
                ⚠ Expired
              </span>
            )}
          </div>

          <p className="oauth-option__description">
            Use your $20-200/month subscription instead of pay-per-use billing
          </p>

          {status.connected ? (
            <div className="oauth-connected">
              {status.accountId && (
                <div className="oauth-info">
                  <span className="oauth-info__label">Account:</span>
                  <span className="oauth-info__value">
                    {status.accountId.substring(0, 12)}...
                  </span>
                </div>
              )}
              {status.expiresAt && (
                <div className="oauth-info">
                  <span className="oauth-info__label">Token:</span>
                  <span
                    className={`oauth-info__value ${status.isExpired ? "oauth-info__value--expired" : ""}`}
                  >
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
            <button
              className="settings-btn settings-btn--primary"
              onClick={startOAuthLogin}
              disabled={loading}
            >
              {loading ? "Connecting..." : `Sign in with ${title}`}
            </button>
          )}

          {status.error && (
            <div className="oauth-error">Error: {status.error}</div>
          )}
        </div>

        {/* Divider */}
        <div className="oauth-divider">
          <span>OR</span>
        </div>

        {/* API Key Option */}
        <div className="oauth-option">
          <div className="oauth-option__header">
            <div className="oauth-option__radio">
              <input
                type="radio"
                name={`${provider}-auth-method`}
                checked={!status.connected}
                readOnly
              />
              <label>API Key (Pay-as-you-go)</label>
            </div>
          </div>

          <p className="oauth-option__description">
            Use API key from {apiKeyHint}
          </p>

          <div className="oauth-api-key-note">
            <strong>Note:</strong> Configure <code>{apiKeyName}</code> in the
            API Keys list below
          </div>
        </div>
      </div>
    </div>
  );
}
