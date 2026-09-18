import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OAuthProviderSource } from "../../../src/core/telemetry/oauthProviderSteps";
import { trackOAuthProviderStep } from "../../lib/oauthProviderTelemetry";
import { ClaudeSetupTokenTerminalExample } from "../Claude/ClaudeSetupTokenTerminalExample";
import {
  cleanClaudeOAuthToken,
  isValidClaudeOAuthToken,
  previewClaudeOAuthToken,
} from "../../utils/claudeOAuthToken";

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_MS = 10 * 60 * 1000;

interface ClaudeOnboardingTokenStepProps {
  oauthSource: OAuthProviderSource;
  running: boolean;
  onRunningChange: (running: boolean) => void;
  onConnected: () => void;
  onStepError: (message: string | null) => void;
}

export function ClaudeOnboardingTokenStep({
  oauthSource,
  running,
  onRunningChange,
  onConnected,
  onStepError,
}: ClaudeOnboardingTokenStepProps) {
  const [pastedToken, setPastedToken] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [pollStatus, setPollStatus] = useState<string | null>(null);
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
    onStepError(null);
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
        setPollStatus("No token found yet. Finish sign-in in Terminal, then try again.");
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
  }, [oauthSource, onConnected, onStepError]);

  useEffect(() => {
    if (fieldShownTrackedRef.current) {
      return;
    }
    fieldShownTrackedRef.current = true;
    trackOAuthProviderStep("anthropic", "paste_field_shown", {
      source: oauthSource,
      flow_source: "terminal",
    });
  }, [oauthSource]);

  useEffect(() => {
    pollStartedAtRef.current = Date.now();
    const tick = () => {
      if (Date.now() - pollStartedAtRef.current > POLL_MAX_MS) {
        return;
      }
      void trySyncFromStorage();
    };
    const intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    const initialId = window.setTimeout(tick, 5_000);
    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(initialId);
    };
  }, [trySyncFromStorage]);

  const handleVerifyToken = async () => {
    onStepError(null);
    if (!tokenLooksValid) {
      onStepError(
        "This doesn't look like a Claude sign-in token. Copy the line starting with sk-ant-oat01-.",
      );
      return;
    }
    onRunningChange(true);
    try {
      const result = await window.electronAPI.oauth.pasteToken("anthropic", cleanedToken, {
        source: oauthSource,
      });
      if (result.success) {
        onConnected();
      } else {
        onStepError(result.error ?? "Could not verify token");
      }
    } catch (error) {
      onStepError(error instanceof Error ? error.message : "Could not verify token");
    } finally {
      onRunningChange(false);
    }
  };

  return (
    <>
      <ClaudeSetupTokenTerminalExample />

      <input
        className="claude-stepper__token-input"
        value={pastedToken}
        onChange={(event) => {
          setPastedToken(event.target.value);
          onStepError(null);
        }}
        placeholder="Paste sk-ant-oat01-… — spaces and line breaks are fine"
        autoComplete="off"
        spellCheck={false}
        disabled={running || syncing}
      />

      <div className="claude-stepper__token-auto">
        <button
          type="button"
          className="onboarding-link claude-stepper__token-auto-btn"
          onClick={() => void trySyncFromStorage()}
          disabled={running || syncing}
        >
          {syncing ? "Checking…" : "I finished signing in — connect automatically"}
        </button>
        {pollStatus && <p className="claude-stepper__token-hint">{pollStatus}</p>}
      </div>

      {pastedToken.trim() && (
        <p
          className={`claude-stepper__token-preview${tokenLooksValid ? "" : " claude-stepper__token-preview--warn"}`}
        >
          {tokenLooksValid ? (
            <>
              ✓ Ready — {previewClaudeOAuthToken(cleanedToken)} ({cleanedToken.length} chars)
              {hadWhitespace && (
                <span className="claude-stepper__token-preview-note">
                  {" "}
                  — we removed extra spaces and line breaks
                </span>
              )}
            </>
          ) : (
            <>
              Looking for text starting with <code>sk-ant-oat01-</code>
              {cleanedToken.length > 0 && cleanedToken.length <= 80
                ? " — pasted text looks too short"
                : ""}
            </>
          )}
        </p>
      )}

      <div className="claude-stepper__st-actions">
        {running ? (
          <div className="claude-stepper__running" aria-live="polite">
            <span className="claude-stepper__running-dot" aria-hidden />
            Verifying with Anthropic…
          </div>
        ) : (
          <button
            type="button"
            className="onboarding-cta onboarding-cta--small"
            onClick={() => void handleVerifyToken()}
            disabled={!tokenLooksValid || syncing}
          >
            Verify token
          </button>
        )}
      </div>
    </>
  );
}
