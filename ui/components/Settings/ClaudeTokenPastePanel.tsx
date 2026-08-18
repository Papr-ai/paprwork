/**
 * Guided Claude OAuth token paste — for non-technical users after terminal sign-in.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OAuthProviderSource } from "../../../src/core/telemetry/oauthProviderSteps";
import { trackOAuthProviderStep } from "../../lib/oauthProviderTelemetry";
import {
  cleanClaudeOAuthToken,
  isValidClaudeOAuthToken,
  previewClaudeOAuthToken,
} from "../../utils/claudeOAuthToken";
import "./ClaudeTokenPastePanel.css";

type PasteMode = "terminal" | "manual";

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_MS = 10 * 60 * 1000;

interface ClaudeTokenPastePanelProps {
  pasteMode: PasteMode;
  oauthSource: OAuthProviderSource;
  onCancel: () => void;
  onConnected: () => void;
}

export function ClaudeTokenPastePanel({
  pasteMode,
  oauthSource,
  onCancel,
  onConnected,
}: ClaudeTokenPastePanelProps) {
  const [pastedToken, setPastedToken] = useState("");
  const [pasting, setPasting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pollStatus, setPollStatus] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const pollStartedAtRef = useRef(Date.now());
  const fieldShownTrackedRef = useRef(false);

  const cleanedToken = useMemo(
    () => (pastedToken.trim() ? cleanClaudeOAuthToken(pastedToken) : ""),
    [pastedToken],
  );
  const tokenLooksValid = cleanedToken.length > 0 && isValidClaudeOAuthToken(cleanedToken);
  const hadWhitespace = pastedToken.length > 0 && pastedToken !== cleanedToken;

  const trySyncFromStorage = useCallback(async (): Promise<boolean> => {
    setSyncing(true);
    setPollStatus(null);
    try {
      const result = await window.electronAPI.oauth.claude.trySyncFromStorage({
        source: oauthSource,
      });
      if (result.success) {
        trackOAuthProviderStep("anthropic", "connected", {
          source: oauthSource,
          flow_source: "keychain",
        });
        onConnected();
        return true;
      }
      if (result.reason === "not_found") {
        setPollStatus("No token found yet. Finish sign-in in the browser, then try again.");
      } else {
        setPollStatus(result.error ?? "Could not detect token yet.");
      }
      return false;
    } catch (error) {
      setPollStatus(error instanceof Error ? error.message : "Detection failed");
      return false;
    } finally {
      setSyncing(false);
    }
  }, [oauthSource, onConnected]);

  // Track paste UI shown (terminal or manual)
  useEffect(() => {
    if (fieldShownTrackedRef.current) return;
    fieldShownTrackedRef.current = true;
    trackOAuthProviderStep("anthropic", "paste_field_shown", {
      source: oauthSource,
      flow_source: pasteMode === "manual" ? "paste" : "terminal",
    });
  }, [pasteMode, oauthSource]);

  // Auto-detect token in Keychain after terminal sign-in (no copy-paste needed)
  useEffect(() => {
    if (pasteMode !== "terminal") return;

    pollStartedAtRef.current = Date.now();

    const tick = () => {
      if (Date.now() - pollStartedAtRef.current > POLL_MAX_MS) return;
      void trySyncFromStorage();
    };

    const intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    // First check after a short delay (user needs time to open browser)
    const initialId = window.setTimeout(tick, 5_000);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(initialId);
    };
  }, [pasteMode, oauthSource, trySyncFromStorage]);

  const handlePasteFromClipboard = async () => {
    setClipboardError(null);
    setPasteError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardError("Your clipboard is empty. Copy the token from Terminal first.");
        return;
      }
      setPastedToken(text);
    } catch {
      setClipboardError(
        "Could not read clipboard. Click in the box below and press Cmd+V (Mac) or Ctrl+V (Windows).",
      );
    }
  };

  const handleSaveToken = async () => {
    setPasteError(null);
    if (!cleanedToken) return;

    if (!isValidClaudeOAuthToken(cleanedToken)) {
      setPasteError(
        "This doesn't look like a Claude sign-in token. In Terminal, copy the long line that starts with sk-ant-oat01-.",
      );
      return;
    }

    setPasting(true);
    try {
      const result = await window.electronAPI.oauth.pasteToken("anthropic", cleanedToken, {
        source: oauthSource,
      });
      if (result.success) {
        onConnected();
      } else {
        setPasteError(result.error ?? "Failed to save token");
      }
    } catch (error) {
      setPasteError(error instanceof Error ? error.message : "Failed to save token");
    } finally {
      setPasting(false);
    }
  };

  return (
    <div className="claude-token-paste">
      <div className="claude-token-paste__hero">
        <h4 className="claude-token-paste__headline">
          {pasteMode === "terminal"
            ? "Finish sign-in in your browser"
            : "Paste your Claude sign-in code"}
        </h4>
        <p className="claude-token-paste__subhead">
          {pasteMode === "terminal"
            ? "We opened Terminal for you. After you sign in, we’ll try to connect automatically — or you can paste the code below."
            : "Run claude setup-token in Terminal, sign in, then paste the code here."}
        </p>
      </div>

      <ol className="claude-token-paste__steps">
        <li>Complete sign-in when your browser opens</li>
        <li>
          In <strong>Terminal</strong>, find the long code starting with{" "}
          <code>sk-ant-oat01-</code>
        </li>
        <li>Copy that entire line and paste it below (extra spaces are OK)</li>
      </ol>

      <div className="claude-token-paste__terminal-mock" aria-hidden="true">
        <div className="claude-token-paste__terminal-bar">Terminal</div>
        <pre className="claude-token-paste__terminal-body">
{`Sign in complete!

Your token (copy this whole line):

`}
          <span className="claude-token-paste__token-highlight">sk-ant-oat01-••••••••••••••••</span>
        </pre>
      </div>

      <div className="claude-token-paste__auto-row">
        <button
          type="button"
          className="settings-btn settings-btn--secondary claude-token-paste__detect-btn"
          onClick={() => void trySyncFromStorage()}
          disabled={syncing || pasting}
        >
          {syncing ? "Checking…" : "I finished signing in — connect automatically"}
        </button>
        {pollStatus && (
          <p className="claude-token-paste__poll-status">{pollStatus}</p>
        )}
      </div>

      <div className="claude-token-paste__divider">
        <span>or paste manually</span>
      </div>

      <div className="claude-token-paste__paste-row">
        <button
          type="button"
          className="settings-btn settings-btn--secondary"
          onClick={() => void handlePasteFromClipboard()}
          disabled={pasting}
        >
          Paste from clipboard
        </button>
        {clipboardError && (
          <p className="claude-token-paste__hint claude-token-paste__hint--warn">{clipboardError}</p>
        )}
      </div>

      <textarea
        className="token-modal__textarea claude-token-paste__textarea"
        value={pastedToken}
        onChange={(e) => {
          setPastedToken(e.target.value);
          setPasteError(null);
        }}
        placeholder="Paste the sk-ant-oat01-… code here — line breaks and spaces are fine"
        rows={4}
      />

      {pastedToken.trim() && (
        <div className="claude-token-paste__preview">
          {tokenLooksValid ? (
            <>
              <span className="claude-token-paste__preview-ok">✓ Ready to save</span>
              {hadWhitespace && (
                <span className="claude-token-paste__preview-note">
                  {" "}
                  — we removed extra spaces and line breaks for you
                </span>
              )}
              <div className="claude-token-paste__preview-token">
                {previewClaudeOAuthToken(cleanedToken)} ({cleanedToken.length} characters)
              </div>
            </>
          ) : (
            <span className="claude-token-paste__preview-warn">
              Looking for text starting with <code>sk-ant-oat01-</code>
              {cleanedToken.length > 0 && cleanedToken.length <= 80
                ? " — pasted text looks too short"
                : ""}
            </span>
          )}
        </div>
      )}

      {pasteError && <p className="claude-token-paste__hint claude-token-paste__hint--warn">{pasteError}</p>}

      <button
        type="button"
        className="settings-btn settings-btn--primary"
        onClick={() => void handleSaveToken()}
        disabled={!tokenLooksValid || pasting || syncing}
        style={{ width: "100%", marginTop: "8px" }}
      >
        {pasting ? "Saving…" : "Save and connect"}
      </button>

      <button
        type="button"
        className="settings-btn settings-btn--secondary"
        onClick={onCancel}
        style={{ width: "100%", marginTop: "4px" }}
      >
        Cancel
      </button>
    </div>
  );
}
