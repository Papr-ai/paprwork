/**
 * PaprLoginSection - Login to Papr platform for automatic API key provisioning
 * Integrates with papr-dev-platform OAuth flow
 * Includes namespace selector for switching between workspaces
 */

import React, { useState, useEffect, useRef } from "react";
import "./PaprLoginSection.css";

interface Namespace {
  id: string;
  name: string;
  environmentType?: string;
}

interface Organization {
  id: string;
  name: string;
  role?: string;
}

interface PaprLoginSectionProps {
  onApiKeyReceived?: (apiKey: string) => void;
}

export function PaprLoginSection({ onApiKeyReceived }: PaprLoginSectionProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Organization state
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [switchingOrganization, setSwitchingOrganization] = useState(false);
  const [organizationsLoaded, setOrganizationsLoaded] = useState(false);

  // Namespace state
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [activeNamespaceId, setActiveNamespaceId] = useState<string | null>(null);
  const [switchingNamespace, setSwitchingNamespace] = useState(false);
  const [namespacesLoaded, setNamespacesLoaded] = useState(false);

  // Check if user is already logged in on mount
  useEffect(() => {
    checkLoginStatus();
  }, []);

  // Load organizations when logged in
  useEffect(() => {
    if (isLoggedIn) {
      loadOrganizations();
    }
  }, [isLoggedIn]);

  // Load namespaces when organization changes
  useEffect(() => {
    if (isLoggedIn && activeOrganizationId) {
      loadNamespaces();
    }
  }, [isLoggedIn, activeOrganizationId]);

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

  const loadOrganizations = async () => {
    try {
      const result = await window.electronAPI.papr.listOrganizations();
      if (result.success && result.organizations) {
        setOrganizations(result.organizations);
        setActiveOrganizationId(result.activeOrganizationId || null);
      }
    } catch (err) {
      console.error("Failed to load organizations:", err);
    } finally {
      setOrganizationsLoaded(true);
    }
  };

  const loadNamespaces = async () => {
    try {
      const result = await window.electronAPI.papr.listNamespaces();
      if (result.success && result.namespaces) {
        setNamespaces(result.namespaces);
        setActiveNamespaceId(result.activeNamespaceId || null);
      }
    } catch (err) {
      console.error("Failed to load namespaces:", err);
    } finally {
      setNamespacesLoaded(true);
    }
  };

  const handleSwitchOrganization = async (organizationId: string) => {
    const org = organizations.find((o) => o.id === organizationId);
    if (!org || organizationId === activeOrganizationId) return;

    setSwitchingOrganization(true);
    setError(null);
    try {
      const result = await window.electronAPI.papr.switchOrganization(organizationId, org.name);
      if (result.success) {
        setActiveOrganizationId(organizationId);
        // Clear namespace state (will reload after org change)
        setActiveNamespaceId(null);
        setNamespaces([]);
        setNamespacesLoaded(false);
      } else {
        setError(result.error || "Failed to switch organization");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch organization");
    } finally {
      setSwitchingOrganization(false);
    }
  };

  const handleSwitchNamespace = async (namespaceId: string) => {
    const ns = namespaces.find((n) => n.id === namespaceId);
    if (!ns || namespaceId === activeNamespaceId) return;

    setSwitchingNamespace(true);
    setError(null);
    try {
      const result = await window.electronAPI.papr.switchNamespace(namespaceId, ns.name);
      if (result.success) {
        setActiveNamespaceId(namespaceId);
        if (result.apiKey && onApiKeyReceived) {
          onApiKeyReceived(result.apiKey);
        }
      } else {
        setError(result.error || "Failed to switch namespace");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch namespace");
    } finally {
      setSwitchingNamespace(false);
    }
  };

  const handleLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.papr.startLogin();
      if (!result.success) {
        throw new Error(result.error || "Failed to start login flow");
      }
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
        setNamespaces([]);
        setActiveNamespaceId(null);
        setNamespacesLoaded(false);
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  // Stable callback refs for IPC listeners (must be at top level, not inside useEffect)
  const handleLoginSuccessRef = useRef((data: { apiKey: string; email: string }) => {
    setIsLoggedIn(true);
    setUserEmail(data.email);
    setIsLoading(false);
    if (onApiKeyReceived) onApiKeyReceived(data.apiKey);
  });

  const handleNamespaceChangedRef = useRef((data: { namespaceId: string; namespaceName: string }) => {
    setActiveNamespaceId(data.namespaceId);
  });

  const handleOrganizationChangedRef = useRef((data: { organizationId: string; organizationName: string }) => {
    setActiveOrganizationId(data.organizationId);
    loadNamespaces();
  });

  // Listen for login/logout/namespace events
  useEffect(() => {
    const loginCb = handleLoginSuccessRef.current;
    const nsCb = handleNamespaceChangedRef.current;
    const orgCb = handleOrganizationChangedRef.current;

    window.electronAPI.papr.onLoginSuccess(loginCb);
    window.electronAPI.papr.onNamespaceChanged(nsCb);
    window.electronAPI.papr.onOrganizationChanged(orgCb);

    const handleLoginSuccess = (event: CustomEvent) => {
      const { apiKey, email } = event.detail;
      setIsLoggedIn(true);
      setUserEmail(email);
      setIsLoading(false);
      if (onApiKeyReceived) onApiKeyReceived(apiKey);
    };

    const handleLoginError = (event: CustomEvent) => {
      setError(event.detail.error);
      setIsLoading(false);
    };

    const handleLogoutSuccess = () => {
      setIsLoggedIn(false);
      setUserEmail(null);
      setOrganizations([]);
      setActiveOrganizationId(null);
      setNamespaces([]);
      setActiveNamespaceId(null);
    };

    window.addEventListener("papr-auth-success", handleLoginSuccess as EventListener);
    window.addEventListener("papr-login-error", handleLoginError as EventListener);
    window.addEventListener("papr-logout-success", handleLogoutSuccess as EventListener);

    return () => {
      window.electronAPI.papr.removeLoginSuccessListener(loginCb);
      window.electronAPI.papr.removeNamespaceChangedListener(nsCb);
      window.electronAPI.papr.removeOrganizationChangedListener(orgCb);
      window.removeEventListener("papr-auth-success", handleLoginSuccess as EventListener);
      window.removeEventListener("papr-login-error", handleLoginError as EventListener);
      window.removeEventListener("papr-logout-success", handleLogoutSuccess as EventListener);
    };
  }, []);

  if (isLoggedIn) {
    const activeNs = namespaces.find((n) => n.id === activeNamespaceId);
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

        {/* Organization Selector */}
        {organizationsLoaded && organizations.length > 1 && (
          <div className="papr-namespace-section">
            <label className="papr-namespace-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              Organization
            </label>
            <div className="papr-namespace-select-wrapper">
              <select
                className="papr-namespace-select"
                value={activeOrganizationId || ""}
                onChange={(e) => handleSwitchOrganization(e.target.value)}
                disabled={switchingOrganization}
              >
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}{org.role ? ` (${org.role})` : ""}
                  </option>
                ))}
              </select>
              {switchingOrganization && (
                <svg className="papr-namespace-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25"/>
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              )}
            </div>
          </div>
        )}

        {/* Namespace Selector */}
        {namespacesLoaded && namespaces.length > 0 && (
          <div className="papr-namespace-section">
            <label className="papr-namespace-label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              Namespace
            </label>
            <div className="papr-namespace-select-wrapper">
              <select
                className="papr-namespace-select"
                value={activeNamespaceId || ""}
                onChange={(e) => handleSwitchNamespace(e.target.value)}
                disabled={switchingNamespace}
              >
                {namespaces.map((ns) => (
                  <option key={ns.id} value={ns.id}>
                    {ns.name}{ns.environmentType ? ` (${ns.environmentType})` : ""}
                  </option>
                ))}
              </select>
              {switchingNamespace && (
                <svg className="papr-namespace-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25"/>
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              )}
            </div>
            {activeNs && (
              <p className="papr-namespace-hint">
                API calls will use the <strong>{activeNs.name}</strong> namespace
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="papr-login-error" style={{ marginTop: "12px" }}>
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
