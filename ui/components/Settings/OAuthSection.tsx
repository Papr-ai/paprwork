/**
 * OAuthSection - OAuth authentication UI for OpenAI and Claude
 */

import React, { useState, useMemo, useEffect } from "react";
import { useOAuth } from "../../hooks/useOAuth";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import type { OAuthProviderSource } from "../../../src/core/telemetry/oauthProviderSteps";
import { trackOAuthProviderStep } from "../../lib/oauthProviderTelemetry";
import { getOnboardingState } from "../../utils/onboardingState";
import { cleanClaudeOAuthToken } from "../../utils/claudeOAuthToken";
import { ClaudeTokenPastePanel } from "./ClaudeTokenPastePanel";
import "./SettingsView.css";

type PasteMode = "idle" | "terminal" | "manual";

function resolveOAuthSource(): OAuthProviderSource {
  const { phase } = getOnboardingState();
  if (
    phase === "welcome" ||
    phase === "connect_papr" ||
    phase === "connect_model" ||
    phase === "choose_intent"
  ) {
    return "onboarding";
  }
  return "settings";
}

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
  const oauthSource = useMemo(resolveOAuthSource, []);
  const { status, loading, startOAuthLogin, disconnect } = useOAuth(provider, {
    source: oauthSource,
  });
  // Persisted in the main process: it decides which credential the gateway ever
  // sees, so this is the mode the agent actually runs on, not just which form shows.
  const [useApiKey, setUseApiKey] = useState(false);
  const [authPrefLoaded, setAuthPrefLoaded] = useState(false);
  const [showPasteToken, setShowPasteToken] = useState(false);
  const [pasteMode, setPasteMode] = useState<PasteMode>("idle");
  const [prevTimedOut, setPrevTimedOut] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const [loadingToken, setLoadingToken] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const [editedToken, setEditedToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [apiKeyError, setApiKeyError] = useState("");
  const { keys, addKey, updateKey, getKeyValue, deleteKey } = useCustomKeys();

  const handleClaudeConnected = () => {
    window.location.reload();
  };

  const handleCancelPaste = () => {
    setShowPasteToken(false);
    setPasteMode("idle");
  };

  const handleViewToken = async () => {
    if (showToken) {
      setShowToken(false);
      setCurrentToken("");
      setEditingToken(false);
      return;
    }
    if (provider !== "anthropic") return;
    setLoadingToken(true);
    try {
      const result = await window.electronAPI.oauth.claude.getToken();
      if (result.success && result.token) {
        setCurrentToken(result.token);
        setShowToken(true);
      } else {
        alert(`Could not retrieve token: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      alert(`Error: ${error}`);
    } finally {
      setLoadingToken(false);
    }
  };

  const handleSaveEditedToken = async () => {
    const cleaned = cleanClaudeOAuthToken(editedToken);
    if (!cleaned.startsWith("sk-ant-oat")) {
      alert("Invalid token format. Claude OAuth tokens should start with sk-ant-oat01-");
      return;
    }
    setSavingToken(true);
    try {
      const result = await window.electronAPI.oauth.pasteToken(provider, cleaned, {
        source: oauthSource,
      });
      if (result.success) {
        setCurrentToken(cleaned);
        setEditingToken(false);
        setEditedToken("");
        alert("Token updated successfully! Refreshing...");
        window.location.reload();
      } else {
        alert(`Failed to save token: ${result.error}`);
      }
    } catch (error) {
      alert(`Error: ${error}`);
    } finally {
      setSavingToken(false);
    }
  };

  // Auto-show paste field when terminal was opened or sign-in fails/times out
  React.useEffect(() => {
    if (provider !== "anthropic") return;
    // Terminal was opened -- show inline paste field
    if (status.showPasteField && pasteMode === "idle") {
      setShowPasteToken(true);
      setPasteMode("terminal");
    }
    // Error/timeout fallback
    const shouldShow = status.timedOut || (status.error && !status.connected);
    if (shouldShow && !prevTimedOut) {
      setShowPasteToken(true);
      if (pasteMode === "idle") setPasteMode("terminal");
      setPrevTimedOut(true);
    }
    if (!status.timedOut && !status.error && prevTimedOut) {
      setPrevTimedOut(false);
    }
  }, [status.timedOut, status.error, status.connected, status.showPasteField, provider]);


  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result =
          await window.electronAPI?.providerAuth?.getPreference(provider);
        if (!cancelled && result?.preference === "apiKey") {
          setUseApiKey(true);
        }
      } catch (error) {
        console.error("Failed to load provider auth preference:", error);
      } finally {
        if (!cancelled) setAuthPrefLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const handleToggleAuthMode = async () => {
    const next = !useApiKey;
    setUseApiKey(next);
    try {
      await window.electronAPI?.providerAuth?.setPreference(
        provider,
        next ? "apiKey" : "oauth",
      );
    } catch (error) {
      console.error("Failed to save provider auth preference:", error);
      setUseApiKey(!next);
    }
  };

  // Check if API key already exists when switching to API key mode
  React.useEffect(() => {
    if (useApiKey) {
      const existingKey = keys.find(k => k.name === apiKeyName);
      if (existingKey) {
        setApiKeySaved(true);
        getKeyValue(existingKey.id).then(val => {
          if (val) setApiKeyValue(val);
        });
      } else {
        setApiKeySaved(false);
        setApiKeyValue("");
      }
    }
  }, [useApiKey, keys]);

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyValue.trim();
    if (!trimmed) return;
    setSavingApiKey(true);
    setApiKeyError("");
    try {
      const existingKey = keys.find(k => k.name === apiKeyName);
      if (existingKey) {
        await updateKey(existingKey.id, { value: trimmed });
      } else {
        await addKey({ name: apiKeyName, value: trimmed, description: `${title} API Key`, permission: "always" });
      }
      setApiKeySaved(true);
    } catch (err: any) {
      setApiKeyError(err.message || "Failed to save key");
    } finally {
      setSavingApiKey(false);
    }
  };

  const handleDeleteApiKey = async () => {
    const existingKey = keys.find(k => k.name === apiKeyName);
    if (existingKey) {
      await deleteKey(existingKey.id);
      setApiKeyValue("");
      setApiKeySaved(false);
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
        {/* In API key mode the OAuth token is deliberately unused, so showing it
            as connected is what made the switch look like it hadn't applied. */}
        {useApiKey ? (
          apiKeySaved && (
            <span className="oauth-badge oauth-badge--connected">
              ✓ Using API key
            </span>
          )
        ) : (
          status.connected && (
            <span className="oauth-badge oauth-badge--connected">
              ✓ Connected
            </span>
          )
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
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  className="settings-btn settings-btn--secondary"
                  onClick={disconnect}
                  disabled={loading}
                  style={{ flex: 1 }}
                >
                  {loading ? "Disconnecting..." : "Disconnect"}
                </button>
                {provider === "anthropic" && (
                  <button
                    className="settings-btn settings-btn--secondary"
                    onClick={handleViewToken}
                    disabled={loadingToken}
                    style={{ flex: 1 }}
                  >
                    {loadingToken ? "Loading..." : showToken ? "Hide Token" : "View Token"}
                  </button>
                )}
              </div>

              {showToken && currentToken && (
                <div style={{ marginTop: "12px" }}>
                  {!editingToken ? (
                    <>
                      <div style={{
                        fontFamily: "monospace",
                        fontSize: "11px",
                        padding: "8px",
                        background: "var(--color-bg-tertiary, #f5f5f5)",
                        borderRadius: "4px",
                        wordBreak: "break-all",
                        userSelect: "all",
                        marginBottom: "8px",
                      }}>
                        {currentToken}
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          className="settings-btn settings-btn--secondary"
                          onClick={() => {
                            navigator.clipboard.writeText(currentToken);
                          }}
                          style={{ flex: 1, fontSize: "12px" }}
                        >
                          Copy
                        </button>
                        <button
                          className="settings-btn settings-btn--secondary"
                          onClick={() => {
                            setEditedToken(currentToken);
                            setEditingToken(true);
                          }}
                          style={{ flex: 1, fontSize: "12px" }}
                        >
                          Edit
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <textarea
                        value={editedToken}
                        onChange={(e) => setEditedToken(e.target.value)}
                        style={{
                          width: "100%",
                          minHeight: "80px",
                          padding: "8px",
                          fontFamily: "monospace",
                          fontSize: "11px",
                          border: "1px solid #ddd",
                          borderRadius: "4px",
                          marginBottom: "8px",
                        }}
                      />
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          className="settings-btn settings-btn--primary"
                          onClick={handleSaveEditedToken}
                          disabled={savingToken || !editedToken.trim()}
                          style={{ flex: 1, fontSize: "12px" }}
                        >
                          {savingToken ? "Saving..." : "Save"}
                        </button>
                        <button
                          className="settings-btn settings-btn--secondary"
                          onClick={() => {
                            setEditingToken(false);
                            setEditedToken("");
                          }}
                          style={{ flex: 1, fontSize: "12px" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="oauth-card__description">
                Use your {subscriptionName} subscription
              </p>
              
              {provider === "anthropic" && !showPasteToken && (
                <div style={{ marginBottom: "12px" }}>
                  <p style={{ fontSize: "13px", color: "var(--color-text-secondary, #666)", marginBottom: "8px" }}>
                    Use your Claude Pro/Max subscription. Click Connect to sign in — we'll check for an existing token, install the CLI if needed, and open a terminal for you.
                  </p>
                </div>
              )}
              
              {status.error && !status.connected && !showPasteToken && (
                <div style={{ padding: "8px 12px", background: "#fff3cd", borderRadius: "6px", fontSize: "13px", color: "#856404", marginBottom: "8px" }}>
                  {status.error}
                </div>
              )}
              
              {!showPasteToken && (
                <div style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
                  <button
                    className="settings-btn settings-btn--primary"
                    onClick={startOAuthLogin}
                    disabled={loading}
                    style={{ width: "100%" }}
                  >
                    {loading ? "Connecting..." : status.error && !status.connected ? "Try Again" : `Connect ${title}`}
                  </button>
                  
                  {provider === "anthropic" && (
                    <button
                      className="settings-btn settings-btn--secondary"
                      onClick={() => {
                        setShowPasteToken(true);
                        setPasteMode("manual");
                        trackOAuthProviderStep(provider, "manual_setup_clicked", {
                          source: oauthSource,
                        });
                      }}
                      style={{ width: "100%" }}
                    >
                      Manual Setup
                    </button>
                  )}
                </div>
              )}
              
              {showPasteToken && provider === "anthropic" && pasteMode !== "idle" && (
                <ClaudeTokenPastePanel
                  pasteMode={pasteMode}
                  oauthSource={oauthSource}
                  onCancel={handleCancelPaste}
                  onConnected={handleClaudeConnected}
                />
              )}
            </>
          )}

        </>
      ) : (
        <div className="oauth-api-key-inline">
            {apiKeySaved ? (
              <div className="oauth-connected-info">
                <div className="oauth-detail">
                  <span className="oauth-detail-label">Key:</span>
                  <span className="oauth-detail-value" style={{ fontFamily: "monospace" }}>
                    {apiKeyValue ? `${apiKeyValue.substring(0, 8)}...${apiKeyValue.slice(-4)}` : "••••••••"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    className="settings-btn settings-btn--secondary"
                    onClick={() => { setApiKeySaved(false); }}
                    style={{ flex: 1 }}
                  >
                    Update Key
                  </button>
                  <button
                    className="settings-btn settings-btn--secondary"
                    onClick={handleDeleteApiKey}
                    style={{ flex: 1 }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="oauth-card__description">
                  Enter your {title} API key
                </p>
                <input
                  type="password"
                  className="oauth-api-key-input"
                  placeholder={apiKeyHint || `Enter ${apiKeyName}`}
                  value={apiKeyValue}
                  onChange={(e) => setApiKeyValue(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    border: "1px solid var(--color-border, #ddd)",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontFamily: "monospace",
                    marginBottom: "8px",
                    background: "var(--color-bg-secondary, #f9f9f9)",
                  }}
                />
                {apiKeyError && (
                  <div style={{ color: "#dc3545", fontSize: "12px", marginBottom: "8px" }}>
                    {apiKeyError}
                  </div>
                )}
                <button
                  className="settings-btn settings-btn--primary"
                  onClick={handleSaveApiKey}
                  disabled={savingApiKey || !apiKeyValue.trim()}
                  style={{ width: "100%" }}
                >
                  {savingApiKey ? "Saving..." : "Save API Key"}
                </button>
              </>
            )}
          </div>
      )}

      {/* Toggle Switch */}
      <div className="oauth-toggle-container">
        <span className={`oauth-toggle-label ${!useApiKey ? 'active' : ''}`}>
          OAuth
        </span>
        <button
          className="oauth-toggle-switch"
          onClick={() => void handleToggleAuthMode()}
          disabled={!authPrefLoaded}
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
