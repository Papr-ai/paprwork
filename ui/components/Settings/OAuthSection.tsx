/**
 * OAuthSection - OAuth authentication UI for OpenAI and Claude
 */

import React, { useState, useMemo } from "react";
import { useOAuth } from "../../hooks/useOAuth";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import "./SettingsView.css";

type OSPlatform = "mac" | "windows" | "linux";

function detectOS(): OSPlatform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac") || ua.includes("darwin")) return "mac";
  if (ua.includes("win")) return "windows";
  return "linux";
}

const OS_TERMINAL_INFO: Record<OSPlatform, { name: string; howToOpen: string }> = {
  mac: {
    name: "Terminal",
    howToOpen: "Press Cmd + Space, type \"Terminal\", and press Enter",
  },
  windows: {
    name: "PowerShell",
    howToOpen: "Press Win key, type \"PowerShell\", and click to open",
  },
  linux: {
    name: "Terminal",
    howToOpen: "Press Ctrl + Alt + T to open a terminal window",
  },
};

// Curl-based installer (works for non-technical users without npm/brew)
const CLAUDE_CLI_INSTALL_STEPS = {
  download: "curl -fsSL https://claude.ai/install.sh | bash",
  move: "sudo mv /tmp/claude /usr/local/bin/claude && sudo chmod +x /usr/local/bin/claude",
  verify: "claude --version",
  refresh: "source ~/.zshrc || source ~/.bashrc",
  // Fallback for users with npm
  npm: "npm install -g @anthropic-ai/claude-code",
};

/** Whether the paste field was triggered by the automated terminal flow */
type PasteMode = "idle" | "terminal" | "manual";

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
  const { status, loading, startOAuthLogin, disconnect } = useOAuth(provider, {
    source: "settings",
  });
  const [useApiKey, setUseApiKey] = useState(false);
  const [showPasteToken, setShowPasteToken] = useState(false);
  const [pasteMode, setPasteMode] = useState<PasteMode>("idle");
  const [prevTimedOut, setPrevTimedOut] = useState(false);
  const [pastedToken, setPastedToken] = useState("");
  const [pasting, setPasting] = useState(false);
  const [showManualInstructions, setShowManualInstructions] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [currentToken, setCurrentToken] = useState("");
  const [loadingToken, setLoadingToken] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const [editedToken, setEditedToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [apiKeyError, setApiKeyError] = useState("");
  const { keys, addKey, updateKey, getKeyValue, deleteKey } = useCustomKeys();
  const os = useMemo(detectOS, []);
  const termInfo = OS_TERMINAL_INFO[os];

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
    const cleaned = editedToken
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]/g, "")
      .replace(/[^a-zA-Z0-9_-]/g, "");
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
    // Aggressively clean: strip ANSI escape codes, all whitespace (including \n, \r),
    // and any non-token characters. Valid token chars are [a-zA-Z0-9_-].
    const cleanedToken = pastedToken
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // ANSI SGR sequences
      .replace(/\x1b\][^\x07]*\x07/g, "")      // ANSI OSC sequences
      .replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]/g, "")  // All whitespace + zero-width chars
      .replace(/[^a-zA-Z0-9_-]/g, "");          // Keep only valid token chars
    if (!cleanedToken) return;
    
    if (!cleanedToken.startsWith("sk-ant-oat")) {
      alert("Invalid token format. Claude OAuth tokens should start with sk-ant-oat01-");
      return;
    }
    
    setPasting(true);
    try {
      const result = await window.electronAPI.oauth.pasteToken(provider, cleanedToken);
      if (result.success) {
        setPastedToken("");
        setShowPasteToken(false);
        alert("Token saved successfully! Refreshing...");
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

  const handleCopy = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
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
                      onClick={() => { setShowPasteToken(true); setPasteMode("manual"); }}
                      style={{ width: "100%" }}
                    >
                      Manual Setup
                    </button>
                  )}
                </div>
              )}
              
              {/* Inline paste section -- shown after Connect opens terminal, or via Manual Setup */}
              {showPasteToken && provider === "anthropic" && (
                <div className="token-paste-section">
                  {/* Context message depending on how we got here */}
                  {pasteMode === "terminal" && (
                    <div className="token-paste-section__info">
                      <span className="token-paste-section__icon">✓</span>
                      <div>
                        <p className="token-paste-section__title">Terminal opened with <code>claude setup-token</code></p>
                        <p className="token-paste-section__hint">
                          Complete the sign-in in your browser, then copy the token from the terminal (starts with <code>sk-ant-oat01-</code>) and paste it below.
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {pasteMode === "manual" && (
                    <div className="token-paste-section__info">
                      <span className="token-paste-section__icon">📋</span>
                      <div>
                        <p className="token-paste-section__title">Manual Setup</p>
                        <p className="token-paste-section__hint">
                          Run <code>claude setup-token</code> in your terminal, complete the browser sign-in, then paste the token below.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Paste field */}
                  <textarea
                    className="token-modal__textarea"
                    value={pastedToken}
                    onChange={(e) => setPastedToken(e.target.value)}
                    placeholder="Paste your token here (starts with sk-ant-oat01-...)"
                    autoFocus
                  />
                  {pastedToken && /[\s\n\r]/.test(pastedToken) && (
                    <p className="token-modal__space-notice">
                      Whitespace/line breaks detected — they'll be removed automatically.
                    </p>
                  )}
                  <button
                    className="settings-btn settings-btn--primary"
                    onClick={handlePasteToken}
                    disabled={!pastedToken.trim() || pasting}
                    style={{ width: "100%", marginTop: "8px" }}
                  >
                    {pasting ? "Saving..." : "Save Token"}
                  </button>

                  {/* Expandable manual instructions */}
                  <button
                    className="token-paste-section__expand-btn"
                    onClick={() => setShowManualInstructions(!showManualInstructions)}
                  >
                    {showManualInstructions ? "Hide" : "Show"} full instructions
                    <span style={{ marginLeft: "4px" }}>{showManualInstructions ? "▲" : "▼"}</span>
                  </button>

                  {showManualInstructions && (
                    <div className="token-paste-section__manual">
                      <div className="token-modal__step">
                        <div className="token-modal__step-number">1</div>
                        <div className="token-modal__step-content">
                          <p className="token-modal__step-title">Open {termInfo.name}</p>
                          <p className="token-modal__step-hint">{termInfo.howToOpen}</p>
                        </div>
                      </div>

                      <div className="token-modal__step">
                        <div className="token-modal__step-number">2</div>
                        <div className="token-modal__step-content">
                          <p className="token-modal__step-title">Run this command</p>
                          <div className="token-modal__command-row">
                            <code className="token-modal__command">claude setup-token</code>
                            <button
                              className="token-modal__copy-btn"
                              onClick={() => handleCopy("claude setup-token", setCopiedCommand)}
                            >
                              {copiedCommand ? "Copied!" : "Copy"}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="token-modal__step">
                        <div className="token-modal__step-number">3</div>
                        <div className="token-modal__step-content">
                          <p className="token-modal__step-title">Sign in and copy the token</p>
                          <p className="token-modal__step-hint">
                            Your browser will open. Sign in with your Claude account. The terminal will print a token starting with <code>sk-ant-oat01-</code>. Copy it and paste it in the field above.
                          </p>
                        </div>
                      </div>

                      <div className="token-modal__tip">
                        <strong>Don't have Claude Code CLI?</strong>
                        <p>Install it first (no npm or Homebrew required), then follow the steps above:</p>
                        
                        <div style={{ marginTop: "12px", marginBottom: "8px" }}>
                          <p style={{ fontSize: "12px", fontWeight: "500", marginBottom: "6px" }}>Step 1: Download and install</p>
                          <div className="token-modal__command-row">
                            <code className="token-modal__command">{CLAUDE_CLI_INSTALL_STEPS.download}</code>
                            <button
                              className="token-modal__copy-btn"
                              onClick={() => handleCopy(CLAUDE_CLI_INSTALL_STEPS.download, setCopiedInstall)}
                            >
                              {copiedInstall ? "Copied!" : "Copy"}
                            </button>
                          </div>
                        </div>

                        <div style={{ marginBottom: "8px" }}>
                          <p style={{ fontSize: "12px", fontWeight: "500", marginBottom: "6px" }}>Step 2: Move to permanent location</p>
                          <div className="token-modal__command-row">
                            <code className="token-modal__command" style={{ fontSize: "10px" }}>{CLAUDE_CLI_INSTALL_STEPS.move}</code>
                            <button
                              className="token-modal__copy-btn"
                              onClick={() => handleCopy(CLAUDE_CLI_INSTALL_STEPS.move, (v) => {})}
                            >
                              Copy
                            </button>
                          </div>
                        </div>

                        <div style={{ marginBottom: "8px" }}>
                          <p style={{ fontSize: "12px", fontWeight: "500", marginBottom: "6px" }}>Step 3: Verify installation</p>
                          <div className="token-modal__command-row">
                            <code className="token-modal__command">{CLAUDE_CLI_INSTALL_STEPS.verify}</code>
                            <button
                              className="token-modal__copy-btn"
                              onClick={() => handleCopy(CLAUDE_CLI_INSTALL_STEPS.verify, (v) => {})}
                            >
                              Copy
                            </button>
                          </div>
                        </div>

                        <div style={{ marginBottom: "12px" }}>
                          <p style={{ fontSize: "12px", fontWeight: "500", marginBottom: "6px" }}>Step 4: Refresh your shell</p>
                          <div className="token-modal__command-row">
                            <code className="token-modal__command">{CLAUDE_CLI_INSTALL_STEPS.refresh}</code>
                            <button
                              className="token-modal__copy-btn"
                              onClick={() => handleCopy(CLAUDE_CLI_INSTALL_STEPS.refresh, (v) => {})}
                            >
                              Copy
                            </button>
                          </div>
                        </div>

                        <p style={{ fontSize: "11px", color: "var(--color-text-secondary, #666)", marginTop: "12px" }}>
                          <strong>Have npm?</strong> You can also use: <code style={{ fontSize: "10px" }}>{CLAUDE_CLI_INSTALL_STEPS.npm}</code>
                        </p>

                        <a
                          href="#"
                          className="token-modal__link"
                          onClick={(e) => {
                            e.preventDefault();
                            window.electronAPI.system.invoke(
                              "shell.openExternal",
                              "https://docs.anthropic.com/en/docs/claude-code/getting-started",
                            );
                          }}
                        >
                          Full installation guide &rarr;
                        </a>
                      </div>
                    </div>
                  )}

                  {/* Cancel button */}
                  <button
                    className="settings-btn settings-btn--secondary"
                    onClick={() => { setShowPasteToken(false); setPasteMode("idle"); setShowManualInstructions(false); setPastedToken(""); }}
                    style={{ width: "100%", marginTop: "4px" }}
                  >
                    Cancel
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
