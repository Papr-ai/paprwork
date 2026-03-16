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
    },
    // Generic paste token that maps providers correctly
    pasteToken: (provider, token) => {
      const channel = provider === "anthropic" ? "auth:claude:paste-token" : `auth:${provider}:paste-token`;
      return ipcRenderer.invoke(channel, token);
    },
  },

  // Ollama API - Auto-install and manage local AI models
  ollama: {
    checkStatus: () => ipcRenderer.invoke("ollama:check-status"),
    ensureModel: (modelName) => ipcRenderer.invoke("ollama:ensure-model", modelName),
    listModels: () => ipcRenderer.invoke("ollama:list-models"),
    hasModel: (modelName) => ipcRenderer.invoke("ollama:has-model", modelName),
    start: () => ipcRenderer.invoke("ollama:start"),
    onDownloadProgress: (callback) => {
      ipcRenderer.on("ollama:download-progress", (_event, data) => callback(data));
    },
    removeDownloadProgressListener: (callback) => {
      ipcRenderer.removeListener("ollama:download-progress", callback);
    },
  },

  // Gateway status notifications (supervisor → renderer)
  gateway: {
    onStatusChange: (callback) => {
      ipcRenderer.on("gateway:status", (_event, data) => callback(data));
    },
    removeStatusListener: () => {
      ipcRenderer.removeAllListeners("gateway:status");
    },
  },

  // Environment info
  env: {
    NODE_ENV: process.env.NODE_ENV || "production",
    GATEWAY_PORT: process.env.GATEWAY_PORT || "18789",
  },
});
