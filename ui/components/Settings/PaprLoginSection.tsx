/**
 * PaprLoginSection - Compact Papr account card with org/namespace selector and schemas
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { gateway } from "../../src/lib/gateway";
import { flushWorkspaceStateToGateway } from "../../lib/persistedAppState";
import {
  MEMORY_AUDIENCE_LABELS,
  type MemoryAudience,
} from "../../constants/memoryScope";
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
  organizationId?: string;
  organizationName?: string;
  workspaceName?: string;
  defaultNamespaceId?: string;
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

interface WorkspaceMember {
  objectId: string;
  user: {
    objectId: string;
    email: string;
    displayName: string;
    profileImageUrl?: string;
    role: string;
  };
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

  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [workspaceMembersLoading, setWorkspaceMembersLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [defaultMemoryScope, setDefaultMemoryScope] =
    useState<MemoryAudience>("user");
  const [savingMemoryDefault, setSavingMemoryDefault] = useState(false);
  const switchingOrganizationRef = useRef(false);
  const activeOrganizationIdRef = useRef<string | null>(null);
  const organizationsRef = useRef(organizations);

  useEffect(() => {
    activeOrganizationIdRef.current = activeOrganizationId;
  }, [activeOrganizationId]);

  useEffect(() => {
    organizationsRef.current = organizations;
  }, [organizations]);

  const resolveParseOrganizationId = useCallback(
    (workspaceId: string | null): string | undefined => {
      if (!workspaceId) return undefined;
      return organizations.find((org) => org.id === workspaceId)?.organizationId;
    },
    [organizations],
  );

  useEffect(() => {
    checkLoginStatus();
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      loadOrganizations();
    }
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) return;
    void (async () => {
      try {
        const response = await gateway.send("settings:get");
        const scope = response?.data?.preferences?.defaultMemoryScope;
        if (scope === "user" || scope === "namespace" || scope === "org") {
          setDefaultMemoryScope(scope);
        }
      } catch (err) {
        console.error("Failed to load default memory scope:", err);
      }
    })();
  }, [isLoggedIn]);

  const handleDefaultMemoryScopeChange = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      const nextScope = event.target.value as MemoryAudience;
      setDefaultMemoryScope(nextScope);
      setSavingMemoryDefault(true);
      try {
        await gateway.send("settings:save-preferences", {
          defaultMemoryScope: nextScope,
        });
      } catch (err) {
        console.error("Failed to save default memory scope:", err);
      } finally {
        setSavingMemoryDefault(false);
      }
    },
    [],
  );

  const loadNamespaces = useCallback(async (parseOrganizationId?: string, forceRefresh = false) => {
    try {
      const result = await window.electronAPI.papr.listNamespaces(
        parseOrganizationId
          ? { organizationId: parseOrganizationId, forceRefresh }
          : forceRefresh
            ? { forceRefresh: true }
            : undefined,
      );
      if (result.success && result.namespaces) {
        setNamespaces(result.namespaces);
        setActiveNamespaceId(result.activeNamespaceId || null);
      }
    } catch (err) {
      console.error("Failed to load namespaces:", err);
    } finally {
      setNamespacesLoaded(true);
    }
  }, []);

  const loadSchemas = useCallback(async () => {
    setSchemasLoading(true);
    try {
      const fetchSchemas = () =>
        gateway.send("memory:list-schemas", {}, { timeoutMs: 45_000 });

      let response: Awaited<ReturnType<typeof fetchSchemas>>;
      try {
        response = await fetchSchemas();
      } catch (firstError) {
        const message =
          firstError instanceof Error ? firstError.message : String(firstError);
        if (!message.includes("timeout")) {
          throw firstError;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        response = await fetchSchemas();
      }

      const data = response.data as
        | { schemas?: SchemaInfo[]; error?: string }
        | undefined;
      if (data?.error) {
        console.warn("[PaprLoginSection] Schema list warning:", data.error);
      }
      setSchemas(data?.schemas ?? []);
    } catch (err) {
      console.error("Failed to load schemas:", err);
      setSchemas([]);
    } finally {
      setSchemasLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isLoggedIn && activeOrganizationId && organizations.length > 0) {
      const parseOrgId = resolveParseOrganizationId(activeOrganizationId);
      if (parseOrgId) {
        void loadNamespaces(parseOrgId, true);
      }
    }
  }, [isLoggedIn, activeOrganizationId, organizations, resolveParseOrganizationId, loadNamespaces]);

  useEffect(() => {
    if (
      isLoggedIn &&
      activeNamespaceId &&
      !switchingOrganization &&
      !switchingNamespace
    ) {
      void loadSchemas();
    }
  }, [
    isLoggedIn,
    activeNamespaceId,
    switchingOrganization,
    switchingNamespace,
    loadSchemas,
  ]);

  useEffect(() => {
    if (isLoggedIn) {
      void loadWorkspaceMembers();
    }
  }, [isLoggedIn, activeOrganizationId]);

  const loadWorkspaceMembers = useCallback(async () => {
    setWorkspaceMembersLoading(true);
    setInviteMessage(null);
    try {
      const result = await window.electronAPI.papr.listWorkspaceMembers();
      if (result.success) {
        setWorkspaceId(result.workspaceId || null);
        setWorkspaceName(result.workspaceName || null);
        setWorkspaceMembers(result.members || []);
      } else {
        setWorkspaceMembers([]);
        setInviteMessage(result.error || "Could not load team members");
      }
    } catch (err) {
      console.error("Failed to load workspace members:", err);
      setInviteMessage("Could not load team members");
    } finally {
      setWorkspaceMembersLoading(false);
    }
  }, []);

  const handleInviteMember = async () => {
    const email = inviteEmail.trim();
    if (!email) return;

    setInviteLoading(true);
    setInviteMessage(null);
    setError(null);
    try {
      const result = await window.electronAPI.papr.inviteWorkspaceMember(email);
      if (result.success) {
        setInviteEmail("");
        setInviteMessage(`Invite sent to ${result.email}`);
        await loadWorkspaceMembers();
      } else {
        setInviteMessage(result.error || "Failed to send invite");
      }
    } catch (err) {
      setInviteMessage(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setInviteLoading(false);
    }
  };

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

  const handleSwitchOrganization = async (organizationId: string) => {
    const org = organizations.find((o) => o.id === organizationId);
    if (!org || organizationId === activeOrganizationId) return;

    const parseOrgId = org.organizationId;
    if (!parseOrgId) {
      setError("Could not resolve organization");
      return;
    }

    setSwitchingOrganization(true);
    switchingOrganizationRef.current = true;
    setError(null);
    setNamespaces([]);
    setNamespacesLoaded(false);
    try {
      await flushWorkspaceStateToGateway();
      const result = await window.electronAPI.papr.switchOrganization(organizationId, org.name);
      if (result.success) {
        setActiveOrganizationId(organizationId);
        if (result.namespaces) {
          setNamespaces(result.namespaces);
          setNamespacesLoaded(true);
        } else {
          await loadNamespaces(parseOrgId, true);
        }
        if (result.activeNamespaceId) {
          setActiveNamespaceId(result.activeNamespaceId);
        } else {
          setActiveNamespaceId(null);
        }
        setSchemas([]);
        setWorkspaceMembers([]);
        setWorkspaceId(null);
        setWorkspaceName(null);
        setInviteEmail("");
        setInviteMessage(null);
        if (result.apiKey && onApiKeyReceived) {
          onApiKeyReceived(result.apiKey);
        }
      } else {
        setError(result.error || "Failed to switch organization");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch organization");
    } finally {
      switchingOrganizationRef.current = false;
      setSwitchingOrganization(false);
    }
  };

  const handleSwitchNamespace = async (namespaceId: string) => {
    const ns = namespaces.find((n) => n.id === namespaceId);
    if (!ns || namespaceId === activeNamespaceId) return;

    setSwitchingNamespace(true);
    setError(null);
    try {
      await flushWorkspaceStateToGateway();
      const result = await window.electronAPI.papr.switchNamespace(namespaceId, ns.name);
      if (result.success) {
        setActiveNamespaceId(namespaceId);
        if (result.apiKey && onApiKeyReceived) {
          onApiKeyReceived(result.apiKey);
        }
      } else {
        setError(result.error || "Failed to switch team");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch team");
    } finally {
      setSwitchingNamespace(false);
    }
  };

  const handleLogin = async (mode: "login" | "signup" = "login") => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.papr.startLogin(mode, "settings");
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
        setWorkspaceMembers([]);
        setWorkspaceId(null);
        setWorkspaceName(null);
        setInviteEmail("");
        setInviteMessage(null);
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

  const handleOrganizationChangedRef = useRef(
    (_data: {
      organizationId: string;
      parseOrganizationId?: string;
      organizationName: string;
      namespaceId?: string;
      namespaceName?: string;
      namespaces?: Namespace[];
    }) => {},
  );

  const handleWorkspaceCacheUpdatedRef = useRef(() => {});

  const organizationChangedListenerRef = useRef(
    (data: {
      organizationId: string;
      parseOrganizationId?: string;
      organizationName: string;
      namespaceId?: string;
      namespaceName?: string;
      namespaces?: Namespace[];
    }) => {
      handleOrganizationChangedRef.current(data);
    },
  );

  const workspaceCacheUpdatedListenerRef = useRef(() => {
    handleWorkspaceCacheUpdatedRef.current();
  });

  useEffect(() => {
    handleOrganizationChangedRef.current = (data) => {
      if (switchingOrganizationRef.current) return;
      setActiveOrganizationId(data.organizationId);
      if (data.namespaceId) {
        setActiveNamespaceId(data.namespaceId);
      }
      if (data.namespaces) {
        setNamespaces(data.namespaces);
        setNamespacesLoaded(true);
      } else if (data.parseOrganizationId) {
        void loadNamespaces(data.parseOrganizationId, true);
      }
    };

    handleWorkspaceCacheUpdatedRef.current = () => {
      void loadOrganizations();
      const parseOrgId = organizationsRef.current.find(
        (org) => org.id === activeOrganizationIdRef.current,
      )?.organizationId;
      if (parseOrgId) {
        void loadNamespaces(parseOrgId);
      }
    };
  }, [loadNamespaces]);

  useEffect(() => {
    const loginCb = handleLoginSuccessRef.current;
    const nsCb = handleNamespaceChangedRef.current;
    const orgCb = organizationChangedListenerRef.current;
    const cacheCb = workspaceCacheUpdatedListenerRef.current;

    window.electronAPI.papr.onLoginSuccess(loginCb);
    window.electronAPI.papr.onNamespaceChanged(nsCb);
    window.electronAPI.papr.onOrganizationChanged(orgCb);
    window.electronAPI.papr.onWorkspaceCacheUpdated(cacheCb);

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
      window.electronAPI.papr.removeWorkspaceCacheUpdatedListener(cacheCb);
      window.removeEventListener("papr-auth-success", handleLoginSuccess as EventListener);
      window.removeEventListener("papr-login-error", handleLoginError as EventListener);
      window.removeEventListener("papr-logout-success", handleLogoutSuccess as EventListener);
    };
  }, []);

  // --- Logged-in state ---
  if (isLoggedIn) {
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

        {/* Organization + Team selectors in a row */}
        <div className="papr-section__selectors">
          {organizationsLoaded && organizations.length > 0 && (
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
                      {org.name}
                    </option>
                  ))}
                </select>
                {switchingOrganization && <Spinner />}
              </div>
            </div>
          )}

          {namespacesLoaded && namespaces.length > 0 && (
            <div className="papr-selector">
              <label className="papr-selector__label">Team</label>
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

          {namespacesLoaded && namespaces.length === 0 && activeOrganizationId && (
            <div className="papr-selector">
              <label className="papr-selector__label">Team</label>
              <div className="papr-selector__empty-row">
                <div className="papr-selector__placeholder">No teams found</div>
                <button
                  type="button"
                  className="papr-team__refresh"
                  onClick={() => {
                    const parseOrgId = resolveParseOrganizationId(activeOrganizationId);
                    if (parseOrgId) void loadNamespaces(parseOrgId, true);
                  }}
                >
                  Refresh
                </button>
              </div>
            </div>
          )}

          {!namespacesLoaded && activeOrganizationId && (
            <div className="papr-selector">
              <label className="papr-selector__label">Team</label>
              <div className="papr-selector__placeholder">
                <Spinner />
                <span>Loading teams…</span>
              </div>
            </div>
          )}
        </div>

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

        <div className="papr-selector papr-memory-default">
          <label className="papr-selector__label" htmlFor="default-memory-scope">
            Default memory sharing
          </label>
          <select
            id="default-memory-scope"
            className="papr-selector__select"
            value={defaultMemoryScope}
            onChange={(event) => void handleDefaultMemoryScopeChange(event)}
            disabled={savingMemoryDefault}
          >
            {(Object.keys(MEMORY_AUDIENCE_LABELS) as MemoryAudience[]).map(
              (audience) => (
                <option key={audience} value={audience}>
                  {MEMORY_AUDIENCE_LABELS[audience].label}
                </option>
              ),
            )}
          </select>
          <p className="papr-memory-default__note">
            {MEMORY_AUDIENCE_LABELS[defaultMemoryScope].description}. Shares
            extracted knowledge from chats — not raw transcripts. Applies to new
            chats; override per chat in the input bar.
          </p>
        </div>

        {/* Team members — needed for My team cloud app access */}
        <WorkspaceTeamSection
          workspaceName={workspaceName || undefined}
          workspaceId={workspaceId || undefined}
          members={workspaceMembers}
          loading={workspaceMembersLoading}
          inviteEmail={inviteEmail}
          inviteLoading={inviteLoading}
          inviteMessage={inviteMessage}
          onInviteEmailChange={setInviteEmail}
          onInvite={handleInviteMember}
          onRefresh={() => void loadWorkspaceMembers()}
          onOpenDashboard={() => void window.electronAPI.papr.openWorkspaceTeam()}
        />

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
        onClick={() => void handleLogin("login")}
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
        Don't have an account?{" "}
        <button
          type="button"
          className="papr-section__inline-link"
          onClick={() => void handleLogin("signup")}
          disabled={isLoading}
        >
          Create account
        </button>
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

function WorkspaceTeamSection({
  workspaceName,
  workspaceId,
  members,
  loading,
  inviteEmail,
  inviteLoading,
  inviteMessage,
  onInviteEmailChange,
  onInvite,
  onRefresh,
  onOpenDashboard,
}: {
  workspaceName?: string;
  workspaceId?: string;
  members: WorkspaceMember[];
  loading: boolean;
  inviteEmail: string;
  inviteLoading: boolean;
  inviteMessage: string | null;
  onInviteEmailChange: (value: string) => void;
  onInvite: () => void;
  onRefresh: () => void;
  onOpenDashboard: () => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div className="papr-team">
      <div className="papr-team__header">
        <button
          className="papr-team__toggle"
          onClick={() => setIsCollapsed(!isCollapsed)}
          type="button"
        >
          <svg
            className={`papr-team__chevron ${!isCollapsed ? "papr-team__chevron--open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>Team</span>
          <span className="papr-team__count">{members.length}</span>
        </button>
        <button
          type="button"
          className="papr-team__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh team"
        >
          {loading ? <Spinner /> : "Refresh"}
        </button>
      </div>

      {!isCollapsed && (
        <div className="papr-team__body">
          <p className="papr-team__hint">
            People here can open cloud apps shared as <strong>My team</strong> on apps.papr.ai.
            Team membership controls cloud access on apps.papr.ai.
          </p>

          {workspaceName && (
            <div className="papr-team__meta">
              <span>{workspaceName}</span>
              {workspaceId && <code className="papr-team__id">{workspaceId}</code>}
            </div>
          )}

          <div className="papr-team__invite">
            <input
              type="email"
              className="papr-team__input"
              placeholder="colleague@company.com"
              value={inviteEmail}
              onChange={(e) => onInviteEmailChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onInvite();
              }}
              disabled={inviteLoading}
            />
            <button
              type="button"
              className="papr-team__invite-btn"
              onClick={onInvite}
              disabled={inviteLoading || !inviteEmail.trim()}
            >
              {inviteLoading ? <Spinner /> : "Invite"}
            </button>
          </div>

          {inviteMessage && (
            <p className="papr-team__message">{inviteMessage}</p>
          )}

          <ul className="papr-team__list">
            {members.map((member) => (
              <li key={member.objectId} className="papr-team__member">
                <div className="papr-team__avatar">
                  {member.user.profileImageUrl ? (
                    <img src={member.user.profileImageUrl} alt="" />
                  ) : (
                    <span>{member.user.displayName.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <div className="papr-team__member-info">
                  <span className="papr-team__member-name">{member.user.displayName}</span>
                  <span className="papr-team__member-email">{member.user.email}</span>
                </div>
                <span className="papr-team__role">{member.user.role}</span>
              </li>
            ))}
            {!loading && members.length === 0 && (
              <li className="papr-team__empty">No team members loaded yet.</li>
            )}
          </ul>

          <button
            type="button"
            className="papr-team__dashboard-link"
            onClick={onOpenDashboard}
          >
            Manage roles in dashboard
          </button>
        </div>
      )}
    </div>
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
