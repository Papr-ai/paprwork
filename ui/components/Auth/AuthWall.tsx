/**
 * AuthWall - Full-screen authentication gate for commercial builds
 * Split-screen design: Sign in form (left) + Papr branding (right)
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
  const [showRefresh, setShowRefresh] = useState(false);

  // Check if user is already authenticated
  useEffect(() => {
    checkAuthentication();

    // Listen for authentication success via DOM event
    const handleAuthSuccess = () => {
      console.log('[AuthWall] Authentication successful via DOM event');
      onAuthenticated();
    };

    window.addEventListener('papr-auth-success', handleAuthSuccess);
    
    // Also poll for authentication status while waiting
    // This ensures we catch auth even if the IPC event is missed
    let pollInterval: NodeJS.Timeout | null = null;
    let refreshTimer: NodeJS.Timeout | null = null;
    
    if (isAuthenticating) {
      pollInterval = setInterval(() => {
        console.log('[AuthWall] Polling authentication status...');
        checkAuthentication();
      }, 2000); // Check every 2 seconds

      // Show refresh button after 5 seconds
      refreshTimer = setTimeout(() => {
        setShowRefresh(true);
      }, 5000);
    }

    return () => {
      window.removeEventListener('papr-auth-success', handleAuthSuccess);
      if (pollInterval) clearInterval(pollInterval);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [onAuthenticated, isAuthenticating]);

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
    setShowRefresh(false); // Reset refresh button
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

  const handleRefresh = () => {
    console.log('[AuthWall] Manual refresh triggered');
    checkAuthentication();
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
      {/* Left Side - Sign In Form */}
      <div className="auth-wall-left">
        <div className="auth-wall-form">
          <h1 className="auth-wall-title">Welcome!</h1>
          <p className="auth-wall-subtitle">Sign up to unfold knowledge</p>

          {isAuthenticating ? (
            <div className="auth-wall-waiting">
              <div className="auth-wall-spinner" />
              <p className="auth-wall-status">Waiting for login...</p>
              <p className="auth-wall-hint">
                Complete the login in your browser, then return here
              </p>
              
              {showRefresh && (
                <button
                  className="auth-wall-refresh-button"
                  onClick={handleRefresh}
                >
                  Already logged in? Refresh
                </button>
              )}
            </div>
          ) : (
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
                <p className="auth-wall-footer-text">
                  I already have an account!{' '}
                  <button 
                    className="auth-wall-link"
                    onClick={handleLogin}
                  >
                    Sign in
                  </button>
                </p>
                <p className="auth-wall-terms">
                  By signing up you agree to the terms of use
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right Side - Papr Branding with Fold */}
      <div className="auth-wall-right">
        <div className="auth-wall-branding">
          {/* Papr Logo + Typefont */}
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

          {/* Fold SVG Background */}
          <div className="auth-wall-fold">
            <svg viewBox="0 0 300 270" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fillRule="evenodd" clipRule="evenodd" d="M300 262C300 266.418 296.418 270 292 270L54.5454 270L300 0L300 262Z" fill="#0080FF"/>
              <path opacity="0.04" fillRule="evenodd" clipRule="evenodd" d="M54.5454 40.5L54.5454 67.5L300 3.05176e-05L54.5454 40.5Z" fill="#212721"/>
              <path opacity="0.48" fillRule="evenodd" clipRule="evenodd" d="M54.5455 270L0 81L300 0L54.5455 270Z" fill="#0080FF"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
