/**
 * AuthWall - Full-screen authentication gate for commercial builds
 * Split-screen design: Sign in form (left) + Papr branding (right)
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { setTelemetryPaprUserId } from "../../lib/telemetry";
import { trackPaprLoginStep } from "../../lib/paprLoginTelemetry";
import {
  type PaprLoginMode,
  type PaprLoginStep,
} from "../../../src/core/telemetry/paprLoginSteps";
import { useProfileStore } from "../../stores/profileStore";
import {
  OrgNamespaceSetup,
  type OrgNamespaceSetupRequest,
} from "./OrgNamespaceSetup";
import { PaprAuthBrowser } from "./PaprAuthBrowser";
import "./AuthWall.css";
import "./PaprAuthBrowser.css";

interface AuthWallProps {
  onAuthenticated: () => void;
}

function trackAuthWallStep(
  step: PaprLoginStep,
  properties?: Record<string, unknown>,
): void {
  trackPaprLoginStep(step, { source: "auth_wall", ...properties });
}

async function identifyTelemetryAfterLogin(): Promise<void> {
  try {
    const profileResult = await window.electronAPI.papr.getProfile();
    const userId = profileResult?.profile?.userId;
    if (userId) {
      setTelemetryPaprUserId(userId);
    }
  } catch {
    // Non-fatal — login still succeeded
  }
}

export function AuthWall({ onAuthenticated }: AuthWallProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRefresh, setShowRefresh] = useState(false);
  const [showManualCode, setShowManualCode] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [setupRequest, setSetupRequest] = useState<OrgNamespaceSetupRequest | null>(null);
  const authWallViewedTracked = useRef(false);
  const waitingForCallbackTracked = useRef(false);

  const handleAuthenticated = useCallback(async () => {
    await identifyTelemetryAfterLogin();
    void useProfileStore.getState().loadProfile({ force: true });
    onAuthenticated();
  }, [onAuthenticated]);

  const checkAuthentication = useCallback(
    async (options?: { fromPoll?: boolean }) => {
      try {
        const result = await window.electronAPI.papr.checkLoginStatus();
        if (result.isLoggedIn) {
          if (options?.fromPoll) {
            trackAuthWallStep("poll_detected_login");
          }
          await handleAuthenticated();
        } else {
          setIsLoading(false);
        }
      } catch (err) {
        console.error("[AuthWall] Failed to check authentication:", err);
        setIsLoading(false);
      }
    },
    [handleAuthenticated],
  );

  useEffect(() => {
    if (!isLoading && !authWallViewedTracked.current) {
      authWallViewedTracked.current = true;
      trackAuthWallStep("auth_wall_viewed");
    }
  }, [isLoading]);

  useEffect(() => {
    if (isAuthenticating && !waitingForCallbackTracked.current) {
      waitingForCallbackTracked.current = true;
      trackAuthWallStep("waiting_for_callback");
    }
    if (!isAuthenticating) {
      waitingForCallbackTracked.current = false;
    }
  }, [isAuthenticating]);

  // Register IPC-to-DOM bridge listeners so deep link callbacks reach us.
  // Without this, preload.cjs never dispatches the DOM events AuthWall listens for.
  useEffect(() => {
    const successCb = () => {
      console.log('[AuthWall] Login success via IPC bridge');
    };
    const errorCb = (data: { error: string }) => {
      console.log('[AuthWall] Login error via IPC bridge:', data?.error);
    };

    window.electronAPI.papr.onLoginSuccess(successCb);
    window.electronAPI.papr.onLoginError(errorCb);

    return () => {
      window.electronAPI.papr.removeLoginSuccessListener?.(successCb);
      window.electronAPI.papr.removeLoginErrorListener?.(errorCb);
    };
  }, []);

  // Check if user is already authenticated
  useEffect(() => {
    void checkAuthentication();

    const handleAuthSuccess = () => {
      console.log("[AuthWall] Authentication successful via DOM event");
      void handleAuthenticated();
    };

    window.addEventListener("papr-auth-success", handleAuthSuccess);

    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    if (isAuthenticating) {
      pollInterval = setInterval(() => {
        void checkAuthentication({ fromPoll: true });
      }, 2000);

      refreshTimer = setTimeout(() => {
        setShowRefresh(true);
      }, 5000);
    }

    return () => {
      window.removeEventListener("papr-auth-success", handleAuthSuccess);
      if (pollInterval) clearInterval(pollInterval);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [checkAuthentication, handleAuthenticated, isAuthenticating]);

  // IPC listeners for login success/error (belt-and-suspenders with DOM events)
  useEffect(() => {
    const papr = window.electronAPI?.papr;
    if (!papr) return;

    const onSuccess = () => {
      void handleAuthenticated();
    };
    const onError = (data: { error: string }) => {
      console.error("[AuthWall] Login error from main process:", data.error);
      setError(data.error);
      setIsAuthenticating(false);
    };
    const onSetupRequired = (data: OrgNamespaceSetupRequest) => {
      setSetupRequest(data);
      setIsAuthenticating(false);
      setError(null);
    };

    papr.onLoginSuccess(onSuccess);
    papr.onLoginError(onError);
    papr.onSetupRequired(onSetupRequired);
    return () => {
      papr.removeLoginSuccessListener(onSuccess);
      papr.removeLoginErrorListener(onError);
      papr.removeSetupRequiredListener(onSetupRequired);
    };
  }, [handleAuthenticated]);

  // Show helpful options progressively as auth takes longer
  useEffect(() => {
    if (!isAuthenticating) return;

    // Show "Check again" button after 5 seconds (fast feedback)
    const refreshTimeout = setTimeout(() => {
      setShowRefresh(true);
    }, 5_000);

    // Show manual code option after 10 seconds
    const manualCodeTimeout = setTimeout(() => {
      setShowManualCode(true);
    }, 10_000);

    // Show helpful hint after 20 seconds
    const hintTimeout = setTimeout(() => {
      trackAuthWallStep("login_timeout");
      setError(
        "You finished signing in in your browser. Go back to Papr Work and tap \"I've signed in — Check now\". If you're still not signed in there, enter the code from your browser.",
      );
    }, 20_000);

    return () => {
      clearTimeout(refreshTimeout);
      clearTimeout(manualCodeTimeout);
      clearTimeout(hintTimeout);
    };
  }, [isAuthenticating]);

  const handleAuth = async (mode: PaprLoginMode) => {
    trackAuthWallStep("login_button_clicked", { mode });
    setIsAuthenticating(true);
    setShowRefresh(false);
    setError(null);

    try {
      const result = await window.electronAPI.papr.startLogin(mode, "auth_wall");
      if (!result.success) {
        setError(result.error || "Failed to start authentication");
        setIsAuthenticating(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open login page");
      setIsAuthenticating(false);
    }
  };

  useEffect(() => {
    const handleSetupRequired = (event: CustomEvent<OrgNamespaceSetupRequest>) => {
      setSetupRequest(event.detail);
      setIsAuthenticating(false);
      setError(null);
    };

    window.addEventListener("papr-setup-required", handleSetupRequired as EventListener);
    return () => {
      window.removeEventListener("papr-setup-required", handleSetupRequired as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleLoginError = (event: CustomEvent<{ error: string }>) => {
      console.error("[AuthWall] Login error event:", event.detail.error);
      setError(event.detail.error);
      setIsAuthenticating(false);
    };

    window.addEventListener("papr-login-error", handleLoginError as EventListener);
    return () => {
      window.removeEventListener("papr-login-error", handleLoginError as EventListener);
    };
  }, []);

  const handleRefresh = () => {
    trackAuthWallStep("check_again_clicked");
    setError(null);
    void checkAuthentication({ fromPoll: true });
  };

  const handleManualCodeSubmit = async () => {
    const cleanCode = manualCode.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    if (cleanCode.length !== 6) {
      setError("Please enter a valid 6-character code");
      return;
    }

    trackAuthWallStep("manual_code_submitted");
    setIsVerifyingCode(true);
    setError(null);

    try {
      const result = await window.electronAPI.papr.verifyManualCode(cleanCode);
      if (result.success) {
        trackAuthWallStep("manual_code_success");
        await handleAuthenticated();
      } else {
        trackAuthWallStep("manual_code_failed", { error: result.error });
        setError(result.error || "Invalid code. Please check and try again.");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to verify code";
      trackAuthWallStep("manual_code_error", { error: errorMsg });
      setError(errorMsg);
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const formatCodeInput = (value: string): string => {
    // Remove non-alphanumeric, uppercase, and format as XXX-XXX
    const clean = value.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 6);
    if (clean.length > 3) {
      return `${clean.slice(0, 3)}-${clean.slice(3)}`;
    }
    return clean;
  };

  if (isLoading) {
    return (
      <div className="auth-wall auth-wall--loading">
        <div className="auth-wall-spinner" />
        <p className="auth-wall-loading-text">Loading...</p>
      </div>
    );
  }

  if (setupRequest) {
    return (
      <OrgNamespaceSetup
        request={setupRequest}
        source="auth_wall"
        onComplete={() => {
          setSetupRequest(null);
          void handleAuthenticated();
        }}
      />
    );
  }

  return (
    <div className="auth-wall auth-wall--split">
      <div className="auth-wall-left">
        <div className="auth-wall-form">
          <h1 className="auth-wall-title">Welcome!</h1>
          <p className="auth-wall-subtitle">Sign in to Papr Work to get started</p>

          {error && (
            <div className="auth-wall-error" role="alert">
              <strong>Sign-in issue</strong>
              <p>{error}</p>
            </div>
          )}

          {isAuthenticating ? (
            <div className="auth-wall-waiting">
              <div className="auth-wall-spinner" />
              <p className="auth-wall-status">
                Finish signing in below — Google and email login work here in Papr Work
              </p>
              <p className="auth-wall-hint">
                If Papr Work asks to open a link, choose <strong>Open</strong> or{" "}
                <strong>Allow</strong>. You can also use the verification code if needed.
              </p>

              {showRefresh && (
                <div className="auth-wall-refresh-section">
                  <button
                    type="button"
                    className="auth-wall-refresh-button"
                    onClick={handleRefresh}
                  >
                    I&apos;ve signed in — Check now
                  </button>
                </div>
              )}

              {showManualCode && (
                <div className="auth-wall-manual-code">
                  <div className="auth-wall-manual-code-divider">
                    <span>or enter your sign-in code</span>
                  </div>
                  <p className="auth-wall-manual-code-hint">
                    On the success page in your browser, copy the 6-character code. Paste it
                    here if Papr Work hasn&apos;t signed you in yet.
                  </p>
                  <div className="auth-wall-manual-code-input-row">
                    <input
                      type="text"
                      className="auth-wall-manual-code-input"
                      placeholder="ABC-123"
                      value={manualCode}
                      onChange={(e) => setManualCode(formatCodeInput(e.target.value))}
                      maxLength={7}
                      disabled={isVerifyingCode}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void handleManualCodeSubmit();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="auth-wall-verify-button"
                      onClick={() => void handleManualCodeSubmit()}
                      disabled={isVerifyingCode || manualCode.replace(/-/g, "").length !== 6}
                    >
                      {isVerifyingCode ? "Verifying..." : "Verify"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="auth-wall-actions">
                <button
                  type="button"
                  className="auth-wall-action-button auth-wall-action-button--primary"
                  onClick={() => void handleAuth("login")}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className="auth-wall-action-button auth-wall-action-button--primary"
                  onClick={() => void handleAuth("signup")}
                >
                  Create Account
                </button>
              </div>

              <p className="auth-wall-terms">
                By continuing you agree to the terms of use
              </p>
            </>
          )}
        </div>
      </div>

      <div className="auth-wall-right">
        {isAuthenticating ? (
          <div className="auth-wall__browser-panel">
            <PaprAuthBrowser visible={isAuthenticating} />
          </div>
        ) : (
          <div className="auth-wall-branding">
            <div className="auth-wall-papr-logo">
              <img
                src="/images/papr-logo.svg"
                alt="Papr Logo"
                className="auth-wall-logo-icon"
              />
              <img
                src="/images/papr typefont.svg"
                alt="Papr"
                className="auth-wall-logo-text"
              />
            </div>

            <div className="auth-wall-fold">
              <svg viewBox="0 0 300 270" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M300 262C300 266.418 296.418 270 292 270L54.5454 270L300 0L300 262Z"
                  fill="#0080FF"
                />
                <path
                  opacity="0.04"
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M54.5454 40.5L54.5454 67.5L300 3.05176e-05L54.5454 40.5Z"
                  fill="#212721"
                />
                <path
                  opacity="0.48"
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M54.5455 270L0 81L300 0L54.5455 270Z"
                  fill="#0080FF"
                />
              </svg>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
