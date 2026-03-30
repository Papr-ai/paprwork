/**
 * AuthWall - Full-screen authentication gate for commercial builds
 * Blocks access until user authenticates with Papr
 */

import React, { useState, useEffect } from "react";
import "./AuthWall.css";

interface AuthWallProps {
  onAuthenticated: () => void;
}

export function AuthWall({ onAuthenticated }: AuthWallProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if user is already authenticated
  useEffect(() => {
    checkAuthentication();

    // Register IPC listener for login success
    window.electronAPI.papr.onLoginSuccess((data) => {
      console.log('[AuthWall] Login success received via IPC:', data);
      onAuthenticated();
    });

    // Also listen for the DOM event as backup
    const handleAuthSuccess = () => {
      console.log('[AuthWall] Authentication successful via DOM event');
      onAuthenticated();
    };

    window.addEventListener('papr-auth-success', handleAuthSuccess);
    return () => window.removeEventListener('papr-auth-success', handleAuthSuccess);
  }, [onAuthenticated]);

  const checkAuthentication = async () => {
    try {
      const result = await window.electronAPI.papr.checkLoginStatus();
      if (result.isLoggedIn) {
        onAuthenticated();
      } else {
        setIsLoading(false);
      }
    } catch (err) {
      console.error("Failed to check authentication:", err);
      setIsLoading(false);
    }
  };

  const handleLogin = async () => {
    setIsAuthenticating(true);
    setError(null);

    try {
      const result = await window.electronAPI.papr.startLogin();
      if (!result.success) {
        setError(result.error || "Failed to start login");
        setIsAuthenticating(false);
      }
      // After user completes login in browser, the deep link will fire
      // and trigger the 'papr-auth-success' event listener above
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open login page");
      setIsAuthenticating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="auth-wall">
        <div className="auth-wall-content">
          <div className="auth-wall-spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wall">
      <div className="auth-wall-content">
        <img
          src="/papr-logo.svg"
          alt="Papr Logo"
          className="auth-wall-logo"
        />

        {isAuthenticating && (
          <div className="auth-wall-waiting">
            <div className="auth-wall-spinner" />
            <p>Waiting for login...</p>
            <p className="auth-wall-hint">
              Complete the login in your browser, then return here
            </p>
          </div>
        )}

        {!isAuthenticating && (
          <>
            <button
              className="auth-wall-login-button"
              onClick={handleLogin}
            >
              Create Account
            </button>

            {error && (
              <div className="auth-wall-error">
                {error}
              </div>
            )}

            <div className="auth-wall-footer">
              <p>
                Don't have an account?{" "}
                <a
                  href="https://dashboard.papr.ai"
                  onClick={(e) => {
                    e.preventDefault();
                    window.electronAPI.shell.openExternal("https://dashboard.papr.ai");
                  }}
                >
                  Sign up at dashboard.papr.ai
                </a>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
