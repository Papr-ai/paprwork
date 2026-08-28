/**
 * Electron API type definitions
 * These match the APIs exposed in src/electron/preload.ts
 */

import type { AgentConfig, CoreMessage, StreamChunk } from "./core";

export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface CustomKeyMetadata {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask";
  clientAccess?: "server" | "client";
  createdAt: string;
  updatedAt: string;
  scope?: "global" | "shared" | "org";
  orgScope?: "organization" | "all" | "global";
  organizationId?: string;
  vaultAudience?: "user" | "namespace" | "org";
}

interface CustomKeysVaultContext {
  organizationId: string | null;
  isLocalVault: boolean;
}

interface CustomKeyInput {
  name: string;
  value: string;
  description?: string;
  permission?: "always" | "ask";
  clientAccess?: "server" | "client";
  orgScope?: "organization" | "all";
  organizationId?: string;
  vaultAudience?: "user" | "namespace" | "org";
}

export interface UpdateStatus {
  status: "checking" | "available" | "not-available" | "downloading" | "ready" | "error";
  version?: string;
  releaseNotes?: string;
  percent?: number;
  error?: string;
  recoveryHint?: string;
}

export interface ElectronAPI {
  // Custom Keys API (secure storage via system keychain)
  customKeys: {
    list: (options?: { orgOnly?: boolean }) => Promise<CustomKeyMetadata[]>;
    getVaultContext: () => Promise<CustomKeysVaultContext>;
    get: (keyId: string) => Promise<string | null>;
    getByName: (name: string) => Promise<string | null>;
    add: (input: CustomKeyInput) => Promise<CustomKeyMetadata>;
    update: (
      keyId: string,
      updates: Partial<CustomKeyInput>,
    ) => Promise<CustomKeyMetadata | null>;
    delete: (keyId: string) => Promise<boolean>;
    resolve: (text: string, allowedKeys?: string[]) => Promise<string>;
    getRequired: (text: string) => Promise<string[]>;
  };

  // Permissions API
  permissions: {
    onKeyRequest: (
      callback: (event: any, request: KeyPermissionRequest) => void,
    ) => void;
    respondToRequest: (response: {
      requestId: string;
      keyName: string;
      response: KeyPermissionResponse;
    }) => void;
    getAll: () => Promise<{
      keyPermissions: Record<string, KeyPermission>;
      settings: PermissionSettings;
    }>;
    updateSettings: (settings: Partial<PermissionSettings>) => Promise<void>;
    resetKey: (keyName: string) => Promise<void>;
    getLevel: () => Promise<PermissionLevel>;
    setLevel: (level: PermissionLevel) => Promise<void>;
  };

  // OAuth API
  oauth: {
    openai: {
      startOAuth: (options?: { source?: "settings" | "onboarding" | "unknown" }) => Promise<{
        success: boolean;
        url?: string;
        error?: string;
      }>;
      getStatus: () => Promise<{
        connected: boolean;
        accountId?: string;
        expiresAt?: string;
        isExpired?: boolean;
        error?: string;
      }>;
      disconnect: () => Promise<{ success: boolean; error?: string }>;
    };
    claude: {
      startOAuth: (options?: { source?: "settings" | "onboarding" | "unknown" }) => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        source?: string;
        terminalOpened?: boolean;
        fallback?: string;
      }>;
      getStatus: () => Promise<{
        connected: boolean;
        accountId?: string;
        expiresAt?: string;
        isExpired?: boolean;
        error?: string;
      }>;
      disconnect: () => Promise<{ success: boolean; error?: string }>;
      getToken: () => Promise<{ success: boolean; token?: string; error?: string }>;
      trySyncFromStorage: (options?: {
        source?: "settings" | "onboarding" | "unknown";
      }) => Promise<{
        success: boolean;
        reason?: "not_found" | "error";
        error?: string;
      }>;
    };
    pasteToken: (
      provider: string,
      token: string,
      options?: { source?: "settings" | "onboarding" | "unknown" },
    ) => Promise<{ success: boolean; error?: string }>;
    onAuthStatus?: (callback: (data: { provider: string; status: string; error?: string }) => void) => (() => void) | undefined;
  };

  // Papr Login API - Authenticate with Papr platform for automatic API key provisioning
  papr: {
    checkLoginStatus: () => Promise<{
      success: boolean;
      isLoggedIn?: boolean;
      email?: string;
      error?: string;
    }>;
    startLogin: (
      mode?: "login" | "signup",
      source?: "auth_wall" | "settings" | "unknown",
    ) => Promise<{
      success: boolean;
      error?: string;
    }>;
    logout: () => Promise<{
      success: boolean;
      error?: string;
    }>;
    /** Verify a manual authentication code (fallback when callback fails) */
    verifyManualCode: (code: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    getProfile: () => Promise<{
      success: boolean;
      profile?: {
        userId: string;
        email: string;
        displayName?: string;
        profileImage?: string;
        authenticatedAt: string;
        organizationId?: string;
        activeNamespaceId?: string;
        activeNamespaceName?: string;
        workspaceId?: string;
        workspaceName?: string;
        planName?: string;
      };
      error?: string;
    }>;
    refreshProfile: () => Promise<{
      success: boolean;
      profile?: {
        userId: string;
        email: string;
        displayName?: string;
        profileImage?: string;
        authenticatedAt: string;
        organizationId?: string;
        activeNamespaceId?: string;
        activeNamespaceName?: string;
        workspaceId?: string;
        workspaceName?: string;
        planName?: string;
      };
      error?: string;
    }>;
    syncProfile: (input: {
      name?: string;
      email?: string;
      imageUrl?: string;
    }) => Promise<{
      success: boolean;
      profileImageUrl?: string;
      syncedImageUrl?: string;
      error?: string;
    }>;
    getActiveWorkspace: () => Promise<{
      success: boolean;
      pointer?: {
        organizationId: string;
        organizationName?: string;
        namespaceId: string;
        namespaceName?: string;
        paprHome: string;
        userDataPath: string;
        activatedAt?: string;
      };
      error?: string;
    }>;
    onLoginSuccess: (callback: (data: { email: string; name?: string; userId?: string }) => void) => void;
    removeLoginSuccessListener: (callback: (data: { email: string; name?: string; userId?: string }) => void) => void;
    onLoginError: (callback: (data: { error: string }) => void) => void;
    removeLoginErrorListener: (callback: (data: { error: string }) => void) => void;
    onSetupRequired: (callback: (data: {
      orgName: string;
      namespaceName: string;
      needsOrg: boolean;
      needsNamespace: boolean;
    }) => void) => void;
    removeSetupRequiredListener: (callback: (data: {
      orgName: string;
      namespaceName: string;
      needsOrg: boolean;
      needsNamespace: boolean;
    }) => void) => void;
    completeOrgSetup: (input: {
      orgName?: string;
      namespaceName?: string;
    }) => Promise<{
      success: boolean;
      email?: string;
      name?: string;
      userId?: string;
      error?: string;
    }>;
    onLogoutSuccess: (callback: () => void) => void;
    removeLogoutSuccessListener: (callback: () => void) => void;
    listNamespaces: (options?: { organizationId?: string; forceRefresh?: boolean; peek?: boolean }) => Promise<{
      success: boolean;
      namespaces?: Array<{ id: string; name: string; environmentType?: string }>;
      activeNamespaceId?: string;
      parseOrganizationId?: string;
      fromCache?: boolean;
      error?: string;
    }>;
    listAllNamespaces: (options?: {
      forceRefresh?: boolean;
      /** When set, only namespaces for orgs in this workspace are returned. */
      workspaceId?: string;
    }) => Promise<{
      success: boolean;
      groups?: Array<{
        workspaceId: string;
        organizationId: string;
        organizationName: string;
        namespaces: Array<{ id: string; name: string; environmentType?: string }>;
      }>;
      activeOrganizationId?: string;
      activeNamespaceId?: string;
      /** True when at least one org's namespaces could not be loaded. */
      partial?: boolean;
      error?: string;
    }>;
    switchNamespace: (
      namespaceId: string,
      namespaceName: string,
      /** Org this namespace belongs to; defaults to the profile's current org. */
      organizationId?: string,
    ) => Promise<{
      success: boolean;
      apiKey?: string;
      error?: string;
    }>;
    onNamespaceChanged: (callback: (data: { namespaceId: string; namespaceName: string }) => void) => void;
    removeNamespaceChangedListener: (callback: (data: { namespaceId: string; namespaceName: string }) => void) => void;
    listOrganizations: () => Promise<{
      success: boolean;
      organizations?: Array<{
        id: string;
        name: string;
        role?: string;
        organizationId?: string;
        organizationName?: string;
        workspaceName?: string;
        defaultNamespaceId?: string;
      }>;
      activeOrganizationId?: string;
      error?: string;
    }>;
    switchOrganization: (
      organizationId: string,
      organizationName: string,
      options?: {
        /** Land on this namespace instead of the org's default. */
        preferredNamespaceId?: string;
        /** Which of the workspace's orgs that namespace belongs to. */
        preferredOrganizationId?: string;
      },
    ) => Promise<{
      success: boolean;
      organizationId?: string;
      parseOrganizationId?: string;
      organizationName?: string;
      namespaces?: Array<{ id: string; name: string; environmentType?: string }>;
      activeNamespaceId?: string;
      activeNamespaceName?: string;
      apiKey?: string;
      error?: string;
    }>;
    onOrganizationChanged: (callback: (data: {
      organizationId: string;
      parseOrganizationId?: string;
      organizationName: string;
      namespaceId?: string;
      namespaceName?: string;
      namespaces?: Array<{ id: string; name: string; environmentType?: string }>;
    }) => void) => void;
    removeOrganizationChangedListener: (callback: (data: {
      organizationId: string;
      parseOrganizationId?: string;
      organizationName: string;
      namespaceId?: string;
      namespaceName?: string;
      namespaces?: Array<{ id: string; name: string; environmentType?: string }>;
    }) => void) => void;
    onWorkspaceSwitchStarting: (callback: (data: {
      organizationId: string;
      parseOrganizationId?: string;
      organizationName?: string;
      namespaceId: string;
      namespaceName?: string;
    }) => void) => void;
    removeWorkspaceSwitchStartingListener: (callback: (data: {
      organizationId: string;
      parseOrganizationId?: string;
      organizationName?: string;
      namespaceId: string;
      namespaceName?: string;
    }) => void) => void;
    onWorkspaceCacheUpdated: (callback: () => void) => void;
    removeWorkspaceCacheUpdatedListener: (callback: () => void) => void;
    listWorkspaceMembers: () => Promise<{
      success: boolean;
      workspaceId?: string;
      workspaceName?: string;
      members?: Array<{
        objectId: string;
        user: {
          objectId: string;
          email: string;
          displayName: string;
          profileImageUrl?: string;
          role: string;
        };
      }>;
      error?: string;
    }>;
    inviteWorkspaceMember: (email: string) => Promise<{
      success: boolean;
      email?: string;
      inviteLink?: string;
      error?: string;
    }>;
    openWorkspaceTeam: () => Promise<{ success: boolean; error?: string }>;
    getPlanSummary: () => Promise<{
      success: boolean;
      summary?: import("../../src/core/types/paprBilling").PaprPlanSummary;
      error?: string;
    }>;
    openBillingPortal: (
      section?: "billing" | "subscriptions" | "invoices",
    ) => Promise<{ success: boolean; error?: string }>;
    openUsageDashboard: () => Promise<{ success: boolean; error?: string }>;
    startCheckout: (input: {
      tier: "starter" | "growth";
      billingCycle: "monthly" | "yearly";
    }) => Promise<{ success: boolean; error?: string }>;
    setMeteredBilling: (
      enabled: boolean,
    ) => Promise<{ success: boolean; enabled?: boolean; error?: string }>;
  };

  cloudPreview: {
    seedSession: (input: {
      namespaceId: string;
      slug: string;
      shareToken?: string;
    }) => Promise<{
      success: boolean;
      cached?: boolean;
      cookieCount?: number;
      error?: string;
    }>;
  };

  // Ollama API - Auto-install and manage local AI models
  ollama: {
    checkStatus: () => Promise<{
      success: boolean;
      isRunning?: boolean;
      models?: string[];
      error?: string;
    }>;
    ensureModel: (modelName: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    listModels: () => Promise<{
      success: boolean;
      models?: string[];
      error?: string;
    }>;
    hasModel: (modelName: string) => Promise<{
      success: boolean;
      hasModel?: boolean;
      error?: string;
    }>;
    getHostMemory: () => Promise<
      | {
          success: true;
          totalBytes: number;
          freeBytes: number;
          totalGb: number;
          freeGb: number;
        }
      | {
          success: false;
          error: string;
        }
    >;
    start: () => Promise<{
      success: boolean;
      started?: boolean;
      error?: string;
    }>;
    onDownloadProgress: (callback: (data: {
      modelName: string;
      status: 'downloading' | 'extracting' | 'complete' | 'error';
      percent: number;
      total?: number;
      completed?: number;
      error?: string;
    }) => void) => void;
    removeDownloadProgressListener: (callback: Function) => void;
  };

  telemetry: {
    getEnabled: () => Promise<{ enabled: boolean }>;
    setEnabled: (
      enabled: boolean,
    ) => Promise<{ success: boolean; enabled: boolean }>;
  };

  replicaE2e: {
    list: () => Promise<{
      tests: Array<{
        id: string;
        name: string;
        npmScript: string;
        description: string;
        requiresAuth: boolean;
      }>;
      available: boolean;
      runningTestId: string | null;
    }>;
    run: (testId: string) => Promise<{
      testId: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
      cancelled: boolean;
    }>;
    cancel: () => Promise<{ cancelled: boolean; testId?: string }>;
  };

  providerAuth: {
    getPreference: (
      provider: "openai" | "anthropic",
    ) => Promise<{ preference: "oauth" | "apiKey" }>;
    setPreference: (
      provider: "openai" | "anthropic",
      preference: "oauth" | "apiKey",
    ) => Promise<{ success: boolean; preference: "oauth" | "apiKey" }>;
  };

  chatAttachments: {
    save: (input: {
      chatId: string;
      fileName: string;
      mimeType: string;
      dataBase64: string;
    }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    readPreview: (input: {
      filePath: string;
      mimeType?: string;
    }) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  };

  agentPreview: {
    show: (webviewId?: string) => Promise<{
      success: boolean;
      webviewId?: string;
      url?: string;
      title?: string;
      error?: string;
    }>;
    isActive: (webviewId?: string) => Promise<{ active: boolean }>;
    captureThumbnail: (webviewId?: string) => Promise<{
      success: boolean;
      screenshot?: string;
      webviewId?: string;
      error?: string;
    }>;
  };

  // App metadata
  getAppVersion: () => Promise<string>;

  // Auto-updater API
  updater: {
    onStatus: (callback: (data: UpdateStatus) => void) => void;
    removeStatusListener: (callback: (data: UpdateStatus) => void) => void;
    install: () => void;
    check: () => void;
  };

  // System integration for mini-apps (generic invoke)
  system: {
    /**
     * Invoke any whitelisted Electron API
     * @param method - Electron API method (e.g., 'shell.openExternal', 'dialog.showSaveDialog')
     * @param args - Arguments to pass to the method
     */
    invoke: (method: string, args: any) => Promise<any>;
  };

  // Legacy agent/chat APIs (not currently used - UI uses WebSocket Gateway)
  agent: {
    stream: (params: {
      sessionId: string;
      message: string;
      config: AgentConfig;
    }) => Promise<{ success: boolean }>;

    onStreamChunk: (callback: (chunk: StreamChunk) => void) => () => void;

    getHistory: (sessionId: string) => Promise<{
      success: boolean;
      messages?: CoreMessage[];
      error?: string;
    }>;

    clearHistory: (sessionId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
  };

  chat: {
    create: (title?: string) => Promise<{
      success: boolean;
      chatId?: string;
      error?: string;
    }>;

    delete: (chatId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;

    list: () => Promise<{
      success: boolean;
      chats?: ChatMetadata[];
      error?: string;
    }>;

    setActive: (chatId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;

    updateTitle: (
      chatId: string,
      title: string,
    ) => Promise<{
      success: boolean;
      error?: string;
    }>;
  };
}

export interface PaprAPI {
  /**
   * Invoke any whitelisted Electron API from mini-app
   * @param method - Electron API method (e.g., 'shell.openExternal', 'dialog.showSaveDialog')
   * @param args - Arguments to pass to the method
   */
  invoke(method: string, ...args: any[]): Promise<any>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    paprAPI?: PaprAPI; // Available in mini-app iframes
  }
}

export {};
