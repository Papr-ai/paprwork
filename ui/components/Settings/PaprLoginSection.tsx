/**
 * PaprLoginSection - Login to Papr platform for automatic API key provisioning
 * Integrates with papr-dev-platform OAuth flow
 */

import React, { useState, useEffect } from "react";
import "./PaprLoginSection.css";

interface PaprLoginSectionProps {
  onApiKeyReceived?: (apiKey: string) => void;
}

export function PaprLoginSection({ onApiKeyReceived }: PaprLoginSectionProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Check if user is already logged in on mount
  useEffect(() => {
    checkLoginStatus();
  }, []);

  const checkLoginStatus = async () => {
    try {
      const result = await window.electronAPI.papr.checkLoginStatus();
      if (result.success && result.isLoggedIn) {
        setIsLoggedIn(true);
        setUserEmail(result.email || null);
      }
    } catch (err) {
      console.error("Failed to check Papr login status:", err);
    }
  };

  const handleLogin = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Open dashboard login with desktop_auth flag
      const result = await window.electronAPI.papr.startLogin();
      
      if (!result.success) {
        throw new Error(result.error || "Failed to start login flow");
      }

      // Keep loading state - will be cleared when we receive the callback
      console.log("Login flow started, waiting for dashboard callback...");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      const result = await window.electronAPI.papr.logout();
      if (result.success) {
        setIsLoggedIn(false);
        setUserEmail(null);
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  // Listen for login success events from main process
  useEffect(() => {
    // Register IPC listener for login success
    window.electronAPI.papr.onLoginSuccess((data) => {
      console.log('[PaprLoginSection] Login success received via IPC:', data);
      setIsLoggedIn(true);
      setUserEmail(data.email);
      setIsLoading(false);
      
      // Refresh keys list in parent component
      if (onApiKeyReceived) {
        onApiKeyReceived(data.apiKey);
      }
    });

    // Also listen for DOM event as backup
    const handleLoginSuccess = (event: CustomEvent) => {
      console.log('[PaprLoginSection] Login success received via DOM event:', event.detail);
      const { apiKey, email } = event.detail;
      setIsLoggedIn(true);
      setUserEmail(email);
      setIsLoading(false);
      
      // Refresh keys list in parent component
      if (onApiKeyReceived) {
        onApiKeyReceived(apiKey);
      }
    };

    const handleLoginError = (event: CustomEvent) => {
      console.log('[PaprLoginSection] Login error:', event.detail);
      setError(event.detail.error);
      setIsLoading(false);
    };

    window.addEventListener("papr-auth-success", handleLoginSuccess as EventListener);
    window.addEventListener("papr-login-error", handleLoginError as EventListener);

    return () => {
      window.removeEventListener("papr-auth-success", handleLoginSuccess as EventListener);
      window.removeEventListener("papr-login-error", handleLoginError as EventListener);
    };
  }, [onApiKeyReceived]);

  if (isLoggedIn) {
    return (
      <div className="papr-login-section papr-login-section--logged-in">
        <div className="papr-login-header">
          <svg className="papr-login-icon papr-login-icon--success" width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <h3 className="papr-login-title">Connected to Papr</h3>
        </div>
        <p className="papr-login-description">
          {userEmail ? `Logged in as ${userEmail}` : "Your API key has been provisioned automatically"}
        </p>
        <button
          type="button"
          className="papr-login-button papr-login-button--secondary"
          onClick={handleLogout}
        >
          Logout
        </button>
      </div>
    );
  }

  return (
    <div className="papr-login-section">
      <div className="papr-login-header">
        <svg className="papr-login-icon" width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <polyline points="10 17 15 12 10 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <line x1="15" y1="12" x2="3" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <h3 className="papr-login-title">Login to Papr</h3>
      </div>
      
      <p className="papr-login-description">
        Connect your Papr account to automatically get an API key for memory and cloud features.
      </p>

      {error && (
        <div className="papr-login-error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span>{error}</span>
        </div>
      )}

      <button
        type="button"
        className="papr-login-button papr-login-button--primary"
        onClick={handleLogin}
        disabled={isLoading}
      >
        {isLoading ? (
          <>
            <svg className="papr-login-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25"/>
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Waiting for login...
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="10 17 15 12 10 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="15" y1="12" x2="3" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Login with Papr
          </>
        )}
      </button>

      <p className="papr-login-note">
        Don't have an account? <a href="https://dashboard.papr.ai" target="_blank" rel="noopener noreferrer">Sign up at dashboard.papr.ai</a>
      </p>
    </div>
  );
}
