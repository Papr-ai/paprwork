/**
 * AuthWall - Full-screen authentication gate for commercial builds
 * Split-screen design: Sign in form (left) + Papr branding (right)
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { setTelemetryPaprUserId, trackEvent } from "../../lib/telemetry";
import { AmplitudeEvents } from "../../../src/core/telemetry/events";
import {
  logPaprLoginStep,
  type PaprLoginMode,
  type PaprLoginStep,
} from "../../../src/core/telemetry/paprLoginSteps";
import { useProfileStore } from "../../stores/profileStore";
import "./AuthWall.css";

interface AuthWallProps {
  onAuthenticated: () => void;
}

function trackAuthWallStep(
  step: PaprLoginStep,
  properties?: Record<string, unknown>,
): void {
  const payload = { step, source: "auth_wall" as const, ...properties };
  logPaprLoginStep(step, payload);
  trackEvent(AmplitudeEvents.PAPR_LOGIN_STEP, payload);
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

    papr.onLoginSuccess(onSuccess);
    papr.onLoginError(onError);
    return () => {
      papr.removeLoginSuccessListener(onSuccess);
      papr.removeLoginErrorListener(onError);
    };
  }, [handleAuthenticated]);

  // Show helpful message if auth takes too long (deep link may not have fired)
  useEffect(() => {
    if (!isAuthenticating) return;

    const timeout = setTimeout(() => {
      trackAuthWallStep("login_timeout");
      setShowRefresh(true);
      setError(
        "Sign-in is taking longer than expected. When your browser asks to open Papr Work, click Open or Allow, then switch back here and tap Check again.",
      );
    }, 90_000);

    return () => clearTimeout(timeout);
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

  if (isLoading) {
    return (
      <div className="auth-wall auth-wall--loading">
        <div className="auth-wall-spinner" />
        <p className="auth-wall-loading-text">Loading...</p>
      </div>
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
                Return to Papr Work — we&apos;ll detect login automatically
              </p>
              <p className="auth-wall-hint">
                Complete sign-in or sign-up in your browser, then switch back to this app.
              </p>

              {showRefresh && (
                <button
                  type="button"
                  className="auth-wall-refresh-button"
                  onClick={handleRefresh}
                >
                  Already signed in? Check again
                </button>
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
      </div>
    </div>
  );
}
