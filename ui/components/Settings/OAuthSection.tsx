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
  const [showPasteToken, setShowPasteToken] = useState(false);
  const [pastedToken, setPastedToken] = useState("");
  const [pasting, setPasting] = useState(false);

  const handlePasteToken = async () => {
    const trimmedToken = pastedToken.trim();
    if (!trimmedToken) return;
    
    // Validate token format before sending
    if (!trimmedToken.startsWith("sk-ant-oat")) {
      alert("Invalid token format. Claude OAuth tokens should start with sk-ant-oat01-");
      return;
    }
    
    setPasting(true);
    try {
      const result = await window.electronAPI.oauth.pasteToken(provider, trimmedToken);
      if (result.success) {
        setPastedToken("");
        setShowPasteToken(false);
        alert("Token saved successfully! Refreshing...");
        // Refresh the page to show updated status
        window.location.reload();
      } else {
        alert(`Failed to save token: ${result.error}`);
      }
    } catch (error) {
      alert(`Error: ${error}`);
    } finally {
      setPasting(false);
    }
  };

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
              
              {provider === "anthropic" && !showPasteToken && (
                <div style={{ marginBottom: "12px" }}>
                  <p style={{ fontSize: "13px", color: "#666", marginBottom: "8px" }}>
                    <strong>Note:</strong> Due to Claude Code CLI limitations, automated setup may not work.
                    If the button below fails, manually run <code style={{ background: "#f5f5f5", padding: "2px 6px", borderRadius: "3px" }}>claude setup-token</code> in your terminal and paste the token below.
                  </p>
                </div>
              )}
              
              <div style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
                <button
                  className="settings-btn settings-btn--primary"
                  onClick={startOAuthLogin}
                  disabled={loading}
                  style={{ width: "100%" }}
                >
                  {loading ? "Connecting..." : `Sign in with ${title}`}
                </button>
                
                {provider === "anthropic" && (
                  <button
                    className="settings-btn settings-btn--secondary"
                    onClick={() => setShowPasteToken(!showPasteToken)}
                    style={{ width: "100%" }}
                  >
                    {showPasteToken ? "Cancel" : "Paste Token Instead"}
                  </button>
                )}
              </div>
              
              {showPasteToken && provider === "anthropic" && (
                <div style={{ marginTop: "12px" }}>
                  <p style={{ fontSize: "13px", marginBottom: "8px" }}>
                    Run <code style={{ background: "#f5f5f5", padding: "2px 6px", borderRadius: "3px" }}>claude setup-token</code> in your terminal,
                    copy the full token (starts with <code>sk-ant-oat01-</code>), and paste it below:
                  </p>
                  <textarea
                    value={pastedToken}
                    onChange={(e) => setPastedToken(e.target.value)}
                    placeholder="Paste your Claude OAuth token here..."
                    style={{
                      width: "100%",
                      minHeight: "80px",
                      padding: "8px",
                      fontFamily: "monospace",
                      fontSize: "12px",
                      border: "1px solid #ddd",
                      borderRadius: "4px",
                      marginBottom: "8px"
                    }}
                  />
                  <button
                    className="settings-btn settings-btn--primary"
                    onClick={handlePasteToken}
                    disabled={!pastedToken.trim() || pasting}
                    style={{ width: "100%" }}
                  >
                    {pasting ? "Saving..." : "Save Token"}
                  </button>
                </div>
              )}
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
