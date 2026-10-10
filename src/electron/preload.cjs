/**
 * Preload Script - Exposes safe Electron APIs to the renderer
 * Runs in isolated context with access to both Node.js and DOM
 *
 * IMPORTANT: Uses CommonJS for maximum Electron compatibility
 * This is the recommended pattern for preload scripts
 */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

console.log("[Preload] Script loaded");

// Expose protected methods that allow the renderer to use ipcRenderer
// without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Custom Keys API
  customKeys: {
    list: (options) => {
      console.log("[Preload] customKeys.list called");
      return ipcRenderer.invoke("custom-keys:list", options);
    },
    getVaultContext: () => ipcRenderer.invoke("custom-keys:get-vault-context"),
    get: (keyId) => ipcRenderer.invoke("custom-keys:get", keyId),
    getByName: (name) => ipcRenderer.invoke("custom-keys:get-by-name", name),
    add: (input) => ipcRenderer.invoke("custom-keys:add", input),
    update: (keyId, updates) =>
      ipcRenderer.invoke("custom-keys:update", keyId, updates),
    delete: (keyId) => ipcRenderer.invoke("custom-keys:delete", keyId),
    resolve: (text, allowedKeys) =>
      ipcRenderer.invoke("custom-keys:resolve", text, allowedKeys),
    getRequired: (text) => ipcRenderer.invoke("custom-keys:get-required", text),
  },

  // Permissions API
  permissions: {
    // Listen for permission requests from main process
    onKeyRequest: (callback) => {
      console.log("[Preload] Setting up permission request listener");
      ipcRenderer.on("permissions:key-request", callback);
    },
    // Send permission response back to main process
    respondToRequest: (response) => {
      console.log("[Preload] Sending permission response:", response);
      ipcRenderer.send("permissions:key-response", response);
    },
    // Get all permissions
    getAll: () => ipcRenderer.invoke("permissions:get-all"),
    // Update permission settings
    updateSettings: (settings) =>
      ipcRenderer.invoke("permissions:update-settings", settings),
    // Reset a key's permission
    resetKey: (keyName) => ipcRenderer.invoke("permissions:reset-key", keyName),
    // Get permission level
    getLevel: () => ipcRenderer.invoke("permissions:get-level"),
    // Set permission level
    setLevel: (level) => ipcRenderer.invoke("permissions:set-level", level),
  },

  // OAuth API
  oauth: {
    openai: {
      startOAuth: (options) => ipcRenderer.invoke("auth:openai:start-oauth", options),
      getStatus: () => ipcRenderer.invoke("auth:openai:get-status"),
      disconnect: () => ipcRenderer.invoke("auth:openai:disconnect"),
      getUsageLimits: () => ipcRenderer.invoke("auth:openai:get-usage-limits"),
    },
    claude: {
      startOAuth: (options) => ipcRenderer.invoke("auth:claude:start-oauth", options),
      getStatus: () => ipcRenderer.invoke("auth:claude:get-status"),
      disconnect: () => ipcRenderer.invoke("auth:claude:disconnect"),
      pasteToken: (token, options) =>
        ipcRenderer.invoke("auth:claude:paste-token", token, options),
      trySyncFromStorage: (options) =>
        ipcRenderer.invoke("auth:claude:try-sync-from-storage", options),
      getToken: () => ipcRenderer.invoke("auth:claude:get-token"),
      getUsageLimits: () => ipcRenderer.invoke("auth:claude:get-usage-limits"),
      onboardingRunCheck: (options) =>
        ipcRenderer.invoke("auth:claude:onboarding-run-check", options),
      onboardingInstallCli: (options) =>
        ipcRenderer.invoke("auth:claude:onboarding-install-cli", options),
      openSetupTokenTerminal: (options) =>
        ipcRenderer.invoke("auth:claude:open-setup-token-terminal", options),
      getSetupTokenShellCommand: () =>
        ipcRenderer.invoke("auth:claude:get-setup-token-shell-command"),
    },
    // Generic paste token that maps providers correctly
    pasteToken: (provider, token, options) => {
      const channel = provider === "anthropic" ? "auth:claude:paste-token" : `auth:${provider}:paste-token`;
      return ipcRenderer.invoke(channel, token, options);
    },
    // Push-based auth status from main process (no polling needed)
    onAuthStatus: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("oauth:status", handler);
      return () => ipcRenderer.removeListener("oauth:status", handler);
    },
  },

  // Papr Login API - Authenticate with Papr platform for automatic API key provisioning
  papr: (() => {
    // Always forward login events to DOM so AuthWall works even before onLoginSuccess is registered.
    ipcRenderer.on("papr:login-error", (_event, data) => {
      window.dispatchEvent(new CustomEvent("papr-login-error", { detail: data }));
    });
    ipcRenderer.on("papr:setup-required", (_event, data) => {
      window.dispatchEvent(new CustomEvent("papr-setup-required", { detail: data }));
    });

    const loginErrorListenerMap = new WeakMap();
    const setupRequiredListenerMap = new WeakMap();
    const workspaceSwitchStartingListenerMap = new WeakMap();
    const workspaceCacheUpdatedListenerMap = new WeakMap();
    // One shared ipcRenderer listener per channel, fanned out to a Set of
    // subscribers. Registering per-subscriber ipcRenderer listeners made the
    // count scale with mounted components (one per keep-alive app tab) and
    // tripped MaxListenersExceededWarning; it also re-dispatched the DOM event
    // once per subscriber. Now: one IPC listener, one DOM event per message.
    const createFanout = (channel, domEventName) => {
      const subscribers = new Set();
      ipcRenderer.on(channel, (_event, data) => {
        for (const cb of Array.from(subscribers)) {
          try {
            cb(data);
          } catch (err) {
            console.error(`[preload] ${channel} subscriber threw:`, err);
          }
        }
        window.dispatchEvent(new CustomEvent(domEventName, { detail: data }));
      });
      return {
        subscribe: (callback) => {
          subscribers.add(callback);
          return () => {
            subscribers.delete(callback);
          };
        },
        unsubscribe: (callback) => {
          subscribers.delete(callback);
        },
      };
    };
    const loginSuccessFanout = createFanout("papr:login-success", "papr-auth-success");
    const logoutSuccessFanout = createFanout("papr:logout-success", "papr-logout-success");
    const namespaceChangedFanout = createFanout("papr:namespace-changed", "papr-namespace-changed");
    const organizationChangedFanout = createFanout("papr:organization-changed", "papr-organization-changed");

    return {
      checkLoginStatus: () => ipcRenderer.invoke("papr:check-login-status"),
      completeOrgSetup: (input) => ipcRenderer.invoke("papr:complete-org-setup", input),
      startLogin: (mode, source) => ipcRenderer.invoke("papr:start-login", mode, source),
      logout: () => ipcRenderer.invoke("papr:logout"),
      verifyManualCode: (code) => ipcRenderer.invoke("papr:verify-manual-code", code),
      getProfile: () => ipcRenderer.invoke("papr:get-profile"),
      refreshProfile: () => ipcRenderer.invoke("papr:refresh-profile"),
      syncProfile: (input) => ipcRenderer.invoke("papr:sync-profile", input),
      getOnboardingState: () => ipcRenderer.invoke("papr:get-onboarding-state"),
      setOnboardingState: (update) => ipcRenderer.invoke("papr:set-onboarding-state", update),
      getActiveWorkspace: () => ipcRenderer.invoke("papr:get-active-workspace"),
      
      // Listen for successful login (via deep link callback)
      onLoginSuccess: (callback) => loginSuccessFanout.subscribe(callback),
      removeLoginSuccessListener: (callback) => loginSuccessFanout.unsubscribe(callback),

      onLoginError: (callback) => {
        const wrapper = (_event, data) => {
          callback(data);
        };
        loginErrorListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:login-error", wrapper);
      },
      removeLoginErrorListener: (callback) => {
        const wrapper = loginErrorListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:login-error", wrapper);
          loginErrorListenerMap.delete(callback);
        }
      },

      onSetupRequired: (callback) => {
        const wrapper = (_event, data) => {
          callback(data);
        };
        setupRequiredListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:setup-required", wrapper);
      },
      removeSetupRequiredListener: (callback) => {
        const wrapper = setupRequiredListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:setup-required", wrapper);
          setupRequiredListenerMap.delete(callback);
        }
      },
      
      // Listen for successful logout
      onLogoutSuccess: (callback) => logoutSuccessFanout.subscribe(callback),
      removeLogoutSuccessListener: (callback) => logoutSuccessFanout.unsubscribe(callback),
      
      listNamespaces: (options) => ipcRenderer.invoke("papr:list-namespaces", options),
      listAllNamespaces: (options) => ipcRenderer.invoke("papr:list-all-namespaces", options),
      switchNamespace: (namespaceId, namespaceName, organizationId) => ipcRenderer.invoke("papr:switch-namespace", namespaceId, namespaceName, organizationId),
      // Returns a disposer. removeNamespaceChangedListener kept for compat.
      onNamespaceChanged: (callback) => namespaceChangedFanout.subscribe(callback),
      removeNamespaceChangedListener: (callback) => namespaceChangedFanout.unsubscribe(callback),

      listOrganizations: () => ipcRenderer.invoke("papr:list-organizations"),
      switchOrganization: (organizationId, organizationName, options) => ipcRenderer.invoke("papr:switch-organization", organizationId, organizationName, options),
      // Returns a disposer. removeOrganizationChangedListener kept for compat.
      onOrganizationChanged: (callback) => organizationChangedFanout.subscribe(callback),
      removeOrganizationChangedListener: (callback) => organizationChangedFanout.unsubscribe(callback),

      onWorkspaceSwitchStarting: (callback) => {
        const wrapper = (_event, data) => {
          callback(data);
          window.dispatchEvent(
            new CustomEvent("papr-workspace-switch-starting", { detail: data }),
          );
        };
        workspaceSwitchStartingListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:workspace-switch-starting", wrapper);
      },
      removeWorkspaceSwitchStartingListener: (callback) => {
        const wrapper = workspaceSwitchStartingListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:workspace-switch-starting", wrapper);
          workspaceSwitchStartingListenerMap.delete(callback);
        }
      },

      onWorkspaceCacheUpdated: (callback) => {
        const wrapper = () => {
          callback();
        };
        workspaceCacheUpdatedListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:workspace-cache-updated", wrapper);
      },
      removeWorkspaceCacheUpdatedListener: (callback) => {
        const wrapper = workspaceCacheUpdatedListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:workspace-cache-updated", wrapper);
          workspaceCacheUpdatedListenerMap.delete(callback);
        }
      },

      listWorkspaceMembers: () => ipcRenderer.invoke("papr:list-workspace-members"),
      inviteWorkspaceMember: (email) =>
        ipcRenderer.invoke("papr:invite-workspace-member", email),
      updateWorkspaceMemberRole: (input) =>
        ipcRenderer.invoke("papr:update-workspace-member-role", input),
      openWorkspaceTeam: () => ipcRenderer.invoke("papr:open-workspace-team"),
      getPlanSummary: (options) =>
        ipcRenderer.invoke("papr:get-plan-summary", options),
      openBillingPortal: (input) =>
        ipcRenderer.invoke("papr:open-billing-portal", input),
      openUsageDashboard: () => ipcRenderer.invoke("papr:open-usage-dashboard"),
      startCheckout: (input) => ipcRenderer.invoke("papr:start-checkout", input),
      subscribeDeveloperPlan: () =>
        ipcRenderer.invoke("papr:subscribe-developer-plan"),
      setMeteredBilling: (enabled) =>
        ipcRenderer.invoke("papr:set-metered-billing", enabled),
    };
  })(),

  cloudPreview: {
    seedSession: (input) => ipcRenderer.invoke("cloud-preview:seed-session", input),
  },

  // Ollama API - Auto-install and manage local AI models
  ollama: (() => {
    // Track wrapper functions for proper cleanup
    const progressListenerMap = new WeakMap();

    return {
      checkStatus: () => ipcRenderer.invoke("ollama:check-status"),
      ensureModel: (modelName) => ipcRenderer.invoke("ollama:ensure-model", modelName),
      listModels: () => ipcRenderer.invoke("ollama:list-models"),
      hasModel: (modelName) => ipcRenderer.invoke("ollama:has-model", modelName),
      getHostMemory: () => ipcRenderer.invoke("ollama:host-memory"),
      start: () => ipcRenderer.invoke("ollama:start"),
      onDownloadProgress: (callback) => {
        // Create wrapper and store mapping
        const wrapper = (_event, data) => callback(data);
        progressListenerMap.set(callback, wrapper);
        ipcRenderer.on("ollama:download-progress", wrapper);
      },
      removeDownloadProgressListener: (callback) => {
        // Remove using the stored wrapper
        const wrapper = progressListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("ollama:download-progress", wrapper);
          progressListenerMap.delete(callback);
        }
      },
    };
  })(),

  // Gateway status notifications (supervisor → renderer)
  gateway: {
    onStatusChange: (callback) => {
      ipcRenderer.on("gateway:status", (_event, data) => callback(data));
    },
    removeStatusListener: () => {
      ipcRenderer.removeAllListeners("gateway:status");
    },
    // For a renderer that loaded after the one-shot push (reload, HMR, crash
    // recovery) and would otherwise sit at "unknown" forever.
    getStatus: () => ipcRenderer.invoke("gateway:get-status"),
  },

  // Auto-updater API
  updater: (() => {
    const statusListenerMap = new WeakMap();

    return {
      onStatus: (callback) => {
        const wrapper = (_event, data) => callback(data);
        statusListenerMap.set(callback, wrapper);
        ipcRenderer.on("updater:status", wrapper);
      },
      removeStatusListener: (callback) => {
        const wrapper = statusListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("updater:status", wrapper);
          statusListenerMap.delete(callback);
        }
      },
      install: () => {
        ipcRenderer.send("updater:install");
      },
      check: () => {
        ipcRenderer.send("updater:check");
      },
      getStatus: () => ipcRenderer.invoke("updater:get-status"),
    };
  })(),

  telemetry: {
    getEnabled: () => ipcRenderer.invoke("telemetry:get-enabled"),
    setEnabled: (enabled) =>
      ipcRenderer.invoke("telemetry:set-enabled", enabled),
  },

  replicaE2e: {
    list: () => ipcRenderer.invoke("replica-e2e:list"),
    run: (testId) => ipcRenderer.invoke("replica-e2e:run", testId),
    cancel: () => ipcRenderer.invoke("replica-e2e:cancel"),
  },

  providerAuth: {
    getPreference: (provider) =>
      ipcRenderer.invoke("provider-auth:get-preference", provider),
    setPreference: (provider, preference) =>
      ipcRenderer.invoke("provider-auth:set-preference", provider, preference),
  },

  chatAttachments: {
    save: (input) => ipcRenderer.invoke("chat:save-attachment", input),
    readPreview: (input) =>
      ipcRenderer.invoke("chat:read-attachment-preview", input),
  },

  // Electron 32 removed File.path, so a dropped file's real location is only
  // reachable through webUtils. Without this every drop has to be base64'd in
  // the renderer and copied through IPC, which is slow and fails outright on
  // large files. Throws for a File not backed by disk (a pasted blob), so the
  // caller treats any failure as "no path" and falls back to copying.
  files: {
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        return "";
      }
    },
  },

  appCover: {
    captureRect: (rect) => ipcRenderer.invoke("app-cover:capture-rect", rect),
  },

  agentPreview: {
    show: (webviewId) => ipcRenderer.invoke("agent-preview:show", webviewId),
    isActive: (webviewId) =>
      ipcRenderer.invoke("agent-preview:is-active", webviewId),
    captureThumbnail: (webviewId) =>
      ipcRenderer.invoke("agent-preview:capture-thumbnail", webviewId),
  },

  platformBrowser: {
    setBounds: (payload) =>
      ipcRenderer.invoke("platform-browser:set-bounds", payload),
    openLogin: (platformId) =>
      ipcRenderer.invoke("platform-browser:open-login", { platformId }),
    getState: (platformId) =>
      ipcRenderer.invoke("platform-browser:get-state", { platformId }),
    reload: (platformId) =>
      ipcRenderer.invoke("platform-browser:reload", { platformId }),
    onUrlChanged: (callback) => {
      const wrapper = (_event, data) => callback(data);
      ipcRenderer.on("platform-browser:url-changed", wrapper);
      return () => {
        ipcRenderer.removeListener("platform-browser:url-changed", wrapper);
      };
    },
    onRedirectLoop: (callback) => {
      const wrapper = (_event, data) => callback(data);
      ipcRenderer.on("platform-browser:redirect-loop", wrapper);
      return () => {
        ipcRenderer.removeListener("platform-browser:redirect-loop", wrapper);
      };
    },
  },

  // App metadata
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),

  // Environment info
  env: {
    NODE_ENV: process.env.NODE_ENV || "production",
    GATEWAY_PORT: process.env.GATEWAY_PORT || "18789",
  },

  // System integration for mini-apps (generic invoke)
  system: {
    invoke: (method, args) => ipcRenderer.invoke("system:invoke", method, args),
  },
});

// Initialize chat IPC listener (forward to DOM event)
console.log("[Preload] Initializing chat listener");
ipcRenderer.on("notification:open-settings", (_event, data) => {
  window.dispatchEvent(new CustomEvent("papr-notification-open-settings", { detail: data }));
});

ipcRenderer.on("chat:open", (_event, data) => {
  window.dispatchEvent(new CustomEvent('papr-chat-open', { detail: data }));
});

ipcRenderer.on("platform-browser:open-tab", (_event, data) => {
  window.dispatchEvent(
    new CustomEvent("papr-platform-browser-open", { detail: data }),
  );
});

// Initialize system power state listeners (forward to DOM events)
console.log("[Preload] Initializing system power state listeners");
ipcRenderer.on("system:suspend", (_event, data) => {
  window.dispatchEvent(new CustomEvent('system:suspend', { detail: data }));
});

ipcRenderer.on("system:resume", (_event, data) => {
  window.dispatchEvent(new CustomEvent('system:resume', { detail: data }));
});

ipcRenderer.on("system:lock-screen", (_event, data) => {
  window.dispatchEvent(new CustomEvent('system:lock-screen', { detail: data }));
});

ipcRenderer.on("system:unlock-screen", (_event, data) => {
  window.dispatchEvent(new CustomEvent('system:unlock-screen', { detail: data }));
});
