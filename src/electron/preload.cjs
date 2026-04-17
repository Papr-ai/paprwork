/**
 * Preload Script - Exposes safe Electron APIs to the renderer
 * Runs in isolated context with access to both Node.js and DOM
 *
 * IMPORTANT: Uses CommonJS for maximum Electron compatibility
 * This is the recommended pattern for preload scripts
 */

const { contextBridge, ipcRenderer } = require("electron");

console.log("[Preload] Script loaded");

// Expose protected methods that allow the renderer to use ipcRenderer
// without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Custom Keys API
  customKeys: {
    list: () => {
      console.log("[Preload] customKeys.list called");
      return ipcRenderer.invoke("custom-keys:list");
    },
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
      startOAuth: () => ipcRenderer.invoke("auth:openai:start-oauth"),
      getStatus: () => ipcRenderer.invoke("auth:openai:get-status"),
      disconnect: () => ipcRenderer.invoke("auth:openai:disconnect"),
    },
    claude: {
      startOAuth: () => ipcRenderer.invoke("auth:claude:start-oauth"),
      getStatus: () => ipcRenderer.invoke("auth:claude:get-status"),
      disconnect: () => ipcRenderer.invoke("auth:claude:disconnect"),
      pasteToken: (token) => ipcRenderer.invoke("auth:claude:paste-token", token),
      getToken: () => ipcRenderer.invoke("auth:claude:get-token"),
    },
    // Generic paste token that maps providers correctly
    pasteToken: (provider, token) => {
      const channel = provider === "anthropic" ? "auth:claude:paste-token" : `auth:${provider}:paste-token`;
      return ipcRenderer.invoke(channel, token);
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
    const loginSuccessListenerMap = new WeakMap();
    const logoutSuccessListenerMap = new WeakMap();
    const namespaceChangedListenerMap = new WeakMap();
    const organizationChangedListenerMap = new WeakMap();

    return {
      checkLoginStatus: () => ipcRenderer.invoke("papr:check-login-status"),
      startLogin: () => ipcRenderer.invoke("papr:start-login"),
      logout: () => ipcRenderer.invoke("papr:logout"),
      getProfile: () => ipcRenderer.invoke("papr:get-profile"),
      
      // Listen for successful login (via deep link callback)
      onLoginSuccess: (callback) => {
        const wrapper = (_event, data) => {
          callback(data);
          // Also dispatch a DOM event for easier listening
          window.dispatchEvent(new CustomEvent('papr-auth-success', { detail: data }));
        };
        loginSuccessListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:login-success", wrapper);
      },
      removeLoginSuccessListener: (callback) => {
        const wrapper = loginSuccessListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:login-success", wrapper);
          loginSuccessListenerMap.delete(callback);
        }
      },
      
      // Listen for successful logout
      onLogoutSuccess: (callback) => {
        const wrapper = () => {
          callback();
          window.dispatchEvent(new CustomEvent('papr-logout-success'));
        };
        logoutSuccessListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:logout-success", wrapper);
      },
      removeLogoutSuccessListener: (callback) => {
        const wrapper = logoutSuccessListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:logout-success", wrapper);
          logoutSuccessListenerMap.delete(callback);
        }
      },
      
      listNamespaces: () => ipcRenderer.invoke("papr:list-namespaces"),
      switchNamespace: (namespaceId, namespaceName) => ipcRenderer.invoke("papr:switch-namespace", namespaceId, namespaceName),
      onNamespaceChanged: (callback) => {
        const wrapper = (_event, data) => {
          callback(data);
          window.dispatchEvent(new CustomEvent('papr-namespace-changed', { detail: data }));
        };
        namespaceChangedListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:namespace-changed", wrapper);
      },
      removeNamespaceChangedListener: (callback) => {
        const wrapper = namespaceChangedListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:namespace-changed", wrapper);
          namespaceChangedListenerMap.delete(callback);
        }
      },
      
      listOrganizations: () => ipcRenderer.invoke("papr:list-organizations"),
      switchOrganization: (organizationId, organizationName) => ipcRenderer.invoke("papr:switch-organization", organizationId, organizationName),
      onOrganizationChanged: (callback) => {
        const wrapper = (_event, data) => {
          callback(data);
          window.dispatchEvent(new CustomEvent('papr-organization-changed', { detail: data }));
        };
        organizationChangedListenerMap.set(callback, wrapper);
        ipcRenderer.on("papr:organization-changed", wrapper);
      },
      removeOrganizationChangedListener: (callback) => {
        const wrapper = organizationChangedListenerMap.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener("papr:organization-changed", wrapper);
          organizationChangedListenerMap.delete(callback);
        }
      },
    };
  })(),

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
    };
  })(),

  telemetry: {
    getEnabled: () => ipcRenderer.invoke("telemetry:get-enabled"),
    setEnabled: (enabled) =>
      ipcRenderer.invoke("telemetry:set-enabled", enabled),
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
ipcRenderer.on("chat:open", (_event, data) => {
  window.dispatchEvent(new CustomEvent('papr-chat-open', { detail: data }));
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
