/**
 * PaprLoginSection - Compact Papr account card with org/namespace selector and schemas
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { gateway } from "../../src/lib/gateway";
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

interface SchemaInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  version?: string;
  nodeTypeCount: number;
  relationshipTypeCount: number;
  nodeTypeNames: string[];
  relationshipTypeNames: string[];
}

interface PaprLoginSectionProps {
  onApiKeyReceived?: (apiKey: string) => void;
}

export function PaprLoginSection({ onApiKeyReceived }: PaprLoginSectionProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [switchingOrganization, setSwitchingOrganization] = useState(false);
  const [organizationsLoaded, setOrganizationsLoaded] = useState(false);

  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [activeNamespaceId, setActiveNamespaceId] = useState<string | null>(null);
  const [switchingNamespace, setSwitchingNamespace] = useState(false);
  const [namespacesLoaded, setNamespacesLoaded] = useState(false);

  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);

  useEffect(() => {
    checkLoginStatus();
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      loadOrganizations();
    }
  }, [isLoggedIn]);

  useEffect(() => {
    if (isLoggedIn && activeOrganizationId) {
      loadNamespaces();
    }
  }, [isLoggedIn, activeOrganizationId]);

  useEffect(() => {
    if (isLoggedIn && activeNamespaceId) {
      loadSchemas();
    }
  }, [isLoggedIn, activeNamespaceId]);

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

  const loadSchemas = useCallback(async () => {
    setSchemasLoading(true);
    try {
      const response = await gateway.send("memory:list-schemas", {});
      const data = response.data as { schemas?: SchemaInfo[] } | undefined;
      setSchemas(data?.schemas ?? []);
    } catch (err) {
      console.error("Failed to load schemas:", err);
      setSchemas([]);
    } finally {
      setSchemasLoading(false);
    }
  }, []);

  const handleSwitchOrganization = async (organizationId: string) => {
    const org = organizations.find((o) => o.id === organizationId);
    if (!org || organizationId === activeOrganizationId) return;

    setSwitchingOrganization(true);
    setError(null);
    try {
      const result = await window.electronAPI.papr.switchOrganization(organizationId, org.name);
      if (result.success) {
        setActiveOrganizationId(organizationId);
        setActiveNamespaceId(null);
        setNamespaces([]);
        setNamespacesLoaded(false);
        setSchemas([]);
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
        setSchemas([]);
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

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
      setSchemas([]);
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

  // --- Logged-in state ---
  if (isLoggedIn) {
    const activeOrg = organizations.find((o) => o.id === activeOrganizationId);
    const activeNs = namespaces.find((n) => n.id === activeNamespaceId);

    return (
      <div className="papr-section">
        {/* Header row: status + logout */}
        <div className="papr-section__header">
          <div className="papr-section__status">
            <span className="papr-section__dot papr-section__dot--connected" />
            <span className="papr-section__status-text">Connected to Papr</span>
            {userEmail && (
              <span className="papr-section__email">{userEmail}</span>
            )}
          </div>
          <button
            type="button"
            className="papr-section__logout"
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>

        {/* Org + Namespace selectors in a row */}
        <div className="papr-section__selectors">
          {organizationsLoaded && organizations.length > 1 && (
            <div className="papr-selector">
              <label className="papr-selector__label">Organization</label>
              <div className="papr-selector__wrapper">
                <select
                  className="papr-selector__select"
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
                {switchingOrganization && <Spinner />}
              </div>
            </div>
          )}

          {namespacesLoaded && namespaces.length > 0 && (
            <div className="papr-selector">
              <label className="papr-selector__label">Namespace</label>
              <div className="papr-selector__wrapper">
                <select
                  className="papr-selector__select"
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
                {switchingNamespace && <Spinner />}
              </div>
            </div>
          )}
        </div>

        {/* Compact summary: org and namespace on one line if only 1 org */}
        {organizationsLoaded && organizations.length <= 1 && activeOrg && (
          <div className="papr-section__summary">
            <span className="papr-section__summary-item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              {activeOrg.name}
            </span>
            {activeNs && (
              <>
                <span className="papr-section__summary-sep">/</span>
                <span className="papr-section__summary-item">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  {activeNs.name}
                </span>
              </>
            )}
          </div>
        )}

        {error && (
          <div className="papr-section__error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
              <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Schemas section */}
        <SchemasSection
          schemas={schemas}
          loading={schemasLoading}
          expandedSchema={expandedSchema}
          onToggleSchema={setExpandedSchema}
          onRefresh={loadSchemas}
          namespaceName={activeNs?.name}
        />
      </div>
    );
  }

  // --- Logged-out state ---
  return (
    <div className="papr-section papr-section--logged-out">
      <div className="papr-section__header">
        <div className="papr-section__status">
          <svg className="papr-section__login-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <polyline points="10 17 15 12 10 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="15" y1="12" x2="3" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="papr-section__status-text">Connect to Papr</span>
        </div>
      </div>

      <p className="papr-section__description">
        Connect your Papr account for memory, cloud sync, and API access.
      </p>

      {error && (
        <div className="papr-section__error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span>{error}</span>
        </div>
      )}

      <button
        type="button"
        className="papr-section__login-btn"
        onClick={handleLogin}
        disabled={isLoading}
      >
        {isLoading ? (
          <>
            <Spinner />
            Waiting for login...
          </>
        ) : (
          "Login with Papr"
        )}
      </button>

      <p className="papr-section__note">
        Don't have an account? <a href="https://dashboard.papr.ai" target="_blank" rel="noopener noreferrer">Sign up</a>
      </p>
    </div>
  );
}

// --- Sub-components ---

function Spinner() {
  return (
    <svg className="papr-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function SchemasSection({
  schemas,
  loading,
  expandedSchema,
  onToggleSchema,
  onRefresh,
  namespaceName,
}: {
  schemas: SchemaInfo[];
  loading: boolean;
  expandedSchema: string | null;
  onToggleSchema: (id: string | null) => void;
  onRefresh: () => void;
  namespaceName?: string;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);

  const activeSchemas = schemas.filter(s => s.status === "active");
  const draftSchemas = schemas.filter(s => s.status === "draft");
  const otherSchemas = schemas.filter(s => s.status !== "active" && s.status !== "draft");

  return (
    <div className="papr-schemas">
      <div className="papr-schemas__header">
        <button
          className="papr-schemas__toggle"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          <svg
            className={`papr-schemas__chevron ${!isCollapsed ? "papr-schemas__chevron--open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <h4 className="papr-schemas__title">
            Schemas
            {schemas.length > 0 && (
              <span className="papr-schemas__count-badge">{schemas.length}</span>
            )}
            {namespaceName && (
              <span className="papr-schemas__ns-badge">{namespaceName}</span>
            )}
          </h4>
        </button>
        <button
          className="papr-schemas__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh schemas"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={loading ? "papr-spinner" : ""}
          >
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
        </button>
      </div>

      {!isCollapsed && (
        <>
          {loading && schemas.length === 0 && (
            <div className="papr-schemas__empty">Loading schemas...</div>
          )}

          {!loading && schemas.length === 0 && (
            <div className="papr-schemas__empty">
              No schemas in this namespace. The agent can create schemas using <code>register_schema</code>.
            </div>
          )}

          {schemas.length > 0 && (
            <div className="papr-schemas__list">
              {[...activeSchemas, ...draftSchemas, ...otherSchemas].map((schema) => (
                <SchemaCard
                  key={schema.id}
                  schema={schema}
                  isExpanded={expandedSchema === schema.id}
                  onToggle={() => onToggleSchema(expandedSchema === schema.id ? null : schema.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SchemaCard({
  schema,
  isExpanded,
  onToggle,
}: {
  schema: SchemaInfo;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`papr-schema-card ${isExpanded ? "papr-schema-card--expanded" : ""}`}>
      <button className="papr-schema-card__header" onClick={onToggle}>
        <div className="papr-schema-card__info">
          <span className="papr-schema-card__name">{schema.name}</span>
          <span className={`papr-schema-card__status papr-schema-card__status--${schema.status}`}>
            {schema.status}
          </span>
        </div>
        <div className="papr-schema-card__meta">
          <span className="papr-schema-card__count">{schema.nodeTypeCount} types</span>
          <span className="papr-schema-card__count">{schema.relationshipTypeCount} rels</span>
          <svg
            className={`papr-schema-card__chevron ${isExpanded ? "papr-schema-card__chevron--open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </button>

      {isExpanded && (
        <div className="papr-schema-card__details">
          {schema.description && (
            <p className="papr-schema-card__description">{schema.description}</p>
          )}

          {schema.nodeTypeNames.length > 0 && (
            <div className="papr-schema-card__section">
              <span className="papr-schema-card__section-label">Node Types</span>
              <div className="papr-schema-card__tags">
                {schema.nodeTypeNames.map((name) => (
                  <span key={name} className="papr-schema-card__tag papr-schema-card__tag--node">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {schema.relationshipTypeNames.length > 0 && (
            <div className="papr-schema-card__section">
              <span className="papr-schema-card__section-label">Relationships</span>
              <div className="papr-schema-card__tags">
                {schema.relationshipTypeNames.map((name) => (
                  <span key={name} className="papr-schema-card__tag papr-schema-card__tag--rel">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {schema.version && (
            <span className="papr-schema-card__version">v{schema.version}</span>
          )}
        </div>
      )}
    </div>
  );
}
