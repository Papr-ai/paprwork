/**
 * AuthWall - Sign-in step for commercial builds.
 * Split-screen design: Sign in form (left) + Papr branding (right)
 *
 * Owns only Papr sign-in detection. Org setup and what happens next are
 * decided by <AuthFlow>; this component just reports "they're signed in".
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { trackPaprLoginStep } from "../../lib/paprLoginTelemetry";
import {
  type PaprLoginMode,
  type PaprLoginStep,
} from "../../../src/core/telemetry/paprLoginSteps";
import { AuthBrandPanel, AuthFormFold } from "./AuthBrandPanel";
import { AuthProgressDots } from "./AuthProgressDots";
import "./onboardingTheme.css";
import "./AuthWall.css";

interface AuthWallProps {
  /** Fired once Papr login is confirmed, by any detection path. */
  onSignedIn: () => void;
  /**
   * Dev preview only. When you're already signed in, every detection path
   * fires immediately and this screen is invisible — this holds it open so
   * the screen can actually be looked at. Never set in production.
   */
  skipAutoDetect?: boolean;
}

function trackAuthWallStep(
  step: PaprLoginStep,
  properties?: Record<string, unknown>,
): void {
  trackPaprLoginStep(step, { source: "auth_wall", ...properties });
}

export function AuthWall({ onSignedIn, skipAutoDetect }: AuthWallProps) {
  const [isLoading, setIsLoading] = useState(!skipAutoDetect);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRefresh, setShowRefresh] = useState(false);
  const [showManualCode, setShowManualCode] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const authWallViewedTracked = useRef(false);
  const waitingForCallbackTracked = useRef(false);
  const signedInReported = useRef(false);

  // Four paths can detect login (DOM event, IPC, 2s poll, manual code) and
  // several fire together. Report upward exactly once.
  const handleAuthenticated = useCallback(async () => {
    if (skipAutoDetect || signedInReported.current) return;
    signedInReported.current = true;
    onSignedIn();
  }, [onSignedIn, skipAutoDetect]);

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
    if (skipAutoDetect) return;
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
  }, [checkAuthentication, handleAuthenticated, isAuthenticating, skipAutoDetect]);

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

    papr.onLoginSuccess(onSuccess);
    papr.onLoginError(onError);
    return () => {
      papr.removeLoginSuccessListener(onSuccess);
      papr.removeLoginErrorListener(onError);
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

  // Org setup is owned by <AuthFlow>; stop the spinner so we don't sit on a
  // "waiting for browser" state behind the setup screen.
  useEffect(() => {
    const handleSetupRequired = () => {
      setIsAuthenticating(false);
      setError(null);
    };

    window.addEventListener("papr-setup-required", handleSetupRequired);
    return () => {
      window.removeEventListener("papr-setup-required", handleSetupRequired);
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
      <div className="onboarding-flow onboarding-loading-center">
        <div className="onboarding-spinner" />
        <p className="onboarding-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="onboarding-flow onboarding-split">
      <AuthBrandPanel />
      <section className="onboarding-split-r">
        <div className="onboarding-split-form">
          <AuthProgressDots activeIndex={0} />
          <AuthFormFold />

          {error && (
            <div className="onboarding-alert" role="alert">
              <strong>Sign-in issue</strong>
              <p>{error}</p>
            </div>
          )}

          {isAuthenticating ? (
            <div className="auth-wall-waiting">
              <div className="onboarding-spinner" />
              <h1 className="onboarding-h1 onboarding-h1--small">
                Finishing sign-in in your browser
              </h1>
              <p className="onboarding-lede">
                We opened a Papr sign-in tab. Come back here when it is done — this window
                updates on its own.
              </p>
              <p className="auth-wall-hint">
                Google, passkeys, and email login work in the browser. You can also use the
                verification code below if needed.
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
              <h1 className="onboarding-h1 onboarding-h1--small">Create your account</h1>
              <p className="onboarding-lede">
                Takes about a minute. Your first working app comes out the other side — not an
                empty workspace.
              </p>
              <div className="onboarding-auth-btns">
                <button
                  type="button"
                  className="onboarding-cta onboarding-cta--wide"
                  onClick={() => void handleAuth("signup")}
                >
                  Create account
                </button>
                <button
                  type="button"
                  className="onboarding-cta onboarding-cta--wide onboarding-cta--ghost"
                  onClick={() => void handleAuth("login")}
                >
                  Sign in
                </button>
              </div>
              <p className="onboarding-auth-alt">
                Google, email or SSO — pick how you sign in on the next screen.
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
