/**
 * OAuthSection - OAuth authentication UI for OpenAI and Claude
 */

import React, { useState } from "react";
import { useOAuth } from "../../hooks/useOAuth";
import { useCustomKeys } from "../../hooks/useCustomKeys";
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
  const [prevTimedOut, setPrevTimedOut] = useState(false);
  const [pastedToken, setPastedToken] = useState("");
  const [pasting, setPasting] = useState(false);
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
    const cleaned = editedToken.replace(/\s+/g, "");
    if (!cleaned.startsWith("sk-ant-oat")) {
      alert("Invalid token format. Claude OAuth tokens should start with sk-ant-oat01-");
      return;
    }
    setSavingToken(true);
    try {
      const result = await window.electronAPI.oauth.pasteToken(provider, cleaned);
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

  // Auto-show paste token fallback when sign-in times out
  React.useEffect(() => {
    if (status.timedOut && !prevTimedOut && provider === "anthropic") {
      setShowPasteToken(true);
      setPrevTimedOut(true);
    }
    if (!status.timedOut && prevTimedOut) {
      setPrevTimedOut(false);
    }
  }, [status.timedOut]);


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
                  <p style={{ fontSize: "13px", color: "#666", marginBottom: "8px" }}>
                    Use your Claude Pro/Max subscription.
                    If sign-in doesn't connect automatically, run <code style={{ background: "#f5f5f5", padding: "2px 6px", borderRadius: "3px" }}>claude setup-token</code> in your terminal and paste the token below.
                  </p>
                </div>
              )}
              
              {status.error && !status.connected && (
                <div style={{ padding: "8px 12px", background: "#fff3cd", borderRadius: "6px", fontSize: "13px", color: "#856404", marginBottom: "8px" }}>
                  {status.error}
                </div>
              )}
              
              <div style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
                <button
                  className="settings-btn settings-btn--primary"
                  onClick={startOAuthLogin}
                  disabled={loading}
                  style={{ width: "100%" }}
                >
                  {loading ? "Connecting..." : status.error && !status.connected ? "Try Again" : `Sign in with ${title}`}
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
