/**
 * Electron Shell
 *
 * Minimal Electron wrapper that loads the UI from the Gateway
 * CommonJS format - Electron's require() is more reliable than ESM
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, powerMonitor, nativeTheme } = require("electron");
const { spawn, execSync } = require("child_process");
const path = require("path");
const http = require("http");
const { autoUpdater } = require("electron-updater");

// Set app name for macOS Keychain (must be before any safeStorage usage)
// This determines the keychain entry name: "Papr Work Safe Storage"
app.setName("Papr Work");

// Import ESM modules dynamically
let CustomKeysStorage;
let KeyPermissionsStorage;
let SettingsStorage;
let initializeCustomKeysIPC;
let setGatewayProcess;
let initializePermissionsIPC;
let initializeOAuthIPC;
let cleanupOAuthServers;
let requestPermissionFromGateway;
let initializeOllamaIPC;
let cleanupOllama;
let initializeTelemetryIPC;
let TelemetryClientClass;
let isTelemetrySendingEnabledFn;
let telemetryClientInstance = null;
let initializePaprLoginIPC;
let cleanupPaprLogin;
let handlePaprAuthCallback;

// Python dependencies IPC
const { initializePythonDepsIPC } = require("./ipc/pythonDeps.cjs");

async function loadESMModules() {
  // Import from compiled dist directory
  const storageModule = await import("../../dist/core/storage/index.js");
  CustomKeysStorage = storageModule.CustomKeysStorage;
  KeyPermissionsStorage = storageModule.KeyPermissionsStorage;
  SettingsStorage = storageModule.SettingsStorage;

  const customKeysIpcModule =
    await import("../../dist/electron/electron/ipc/customKeys.js");
  initializeCustomKeysIPC = customKeysIpcModule.initializeCustomKeysIPC;
  setGatewayProcess = customKeysIpcModule.setGatewayProcess;

  const permissionsIpcModule =
    await import("../../dist/electron/electron/ipc/permissions.js");
  initializePermissionsIPC = permissionsIpcModule.initializePermissionsIPC;
  requestPermissionFromGateway =
    permissionsIpcModule.requestPermissionFromGateway;

  // Import OAuth IPC module
  const oauthIpcModule =
    await import("../../dist/electron/electron/ipc/oauth.js");
  initializeOAuthIPC = oauthIpcModule.initializeOAuthIPC;
  cleanupOAuthServers = oauthIpcModule.cleanupOAuthServers;

  // Import Papr Login IPC module
  const paprLoginIpcModule =
    await import("../../dist/electron/electron/ipc/paprLogin.js");
  initializePaprLoginIPC = paprLoginIpcModule.initializePaprLoginIPC;
  cleanupPaprLogin = paprLoginIpcModule.cleanupPaprLogin;
  handlePaprAuthCallback = paprLoginIpcModule.handlePaprAuthCallback;

  // Import Ollama IPC module
  const ollamaIpcModule =
    await import("../../dist/electron/electron/electron/ipc/ollama.js");
  initializeOllamaIPC = ollamaIpcModule.initializeOllamaIPC;

  // Import Ollama Manager for cleanup
  const ollamaManagerModule =
    await import("../../dist/electron/electron/electron/services/OllamaManager.js");
  const ollamaManager = ollamaManagerModule.getOllamaManager();
  cleanupOllama = () => ollamaManager.cleanup();

  const telemetryIpcModule = await import(
    "../../dist/electron/electron/ipc/telemetry.js"
  );
  initializeTelemetryIPC = telemetryIpcModule.initializeTelemetryIPC;

  const telemetryClientModule = await import(
    "../../dist/electron/core/telemetry/index.js"
  );
  TelemetryClientClass = telemetryClientModule.TelemetryClient;
  isTelemetrySendingEnabledFn = telemetryClientModule.isTelemetrySendingEnabled;
}

// Configuration
const UI_DEV_URL = process.env.UI_DEV_URL || "http://localhost:5173";
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production" || require("path").dirname(__dirname).includes("app.asar");

let mainWindow = null;
let gatewayProcess = null;
const webviewSessions = new Map();
let defaultWebviewId = null;
let webviewCounter = 0;

function isRequestKeysMessage(message) {
  return (
    message &&
    message.type === "REQUEST_KEYS" &&
    typeof message.requestId === "string" &&
    Array.isArray(message.keys)
  );
}

function isRequestPermissionMessage(message) {
  return (
    message &&
    message.type === "REQUEST_PERMISSION" &&
    typeof message.requestId === "string" &&
    typeof message.request === "object" &&
    message.request !== null
  );
}

function isRequestWebviewTestMessage(message) {
  return (
    message &&
    message.type === "REQUEST_WEBVIEW_TEST" &&
    typeof message.requestId === "string" &&
    typeof message.request === "object" &&
    message.request !== null &&
    typeof message.request.action === "string"
  );
}

async function handleWebviewTestRequest(request) {
  const action = request.action;
  const payload = request.payload || {};
  const gatewayHost = "localhost";
  const gatewayPort = String(GATEWAY_PORT);

  if (action === "list") {
    return {
      success: true,
      data: {
        sessions: Array.from(webviewSessions.entries()).map(([id, entry]) => ({
          id,
          url: entry.window.webContents.getURL(),
          title: entry.window.webContents.getTitle(),
          createdAt: entry.createdAt,
        })),
        defaultWebviewId,
      },
    };
  }

  if (action === "close") {
    const id = payload.webviewId || defaultWebviewId;
    if (!id || !webviewSessions.has(id)) {
      return { success: true, data: { closed: false, reason: "not_found" } };
    }
    const entry = webviewSessions.get(id);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.close();
    }
    return { success: true, data: { closed: true, webviewId: id } };
  }

  if (action === "launch") {
    const appId = payload.appId;
    if (typeof appId !== "string" || appId.length === 0) {
      return { success: false, error: "appId is required for launch" };
    }

    const id = `webview-${Date.now()}-${++webviewCounter}`;
    const width = Number(payload.width) || 1280;
    const height = Number(payload.height) || 720;
    const visible = Boolean(payload.visible);
    const url = `http://${gatewayHost}:${gatewayPort}/apps/${appId}/index.html`;

    const win = new BrowserWindow({
      width,
      height,
      show: visible,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webSecurity: false,
      },
    });

    // Open external links from webview windows in the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      const isInternal =
        url.startsWith(`http://localhost:${GATEWAY_PORT}`) ||
        url.startsWith(`http://127.0.0.1:${GATEWAY_PORT}`);
      if (!isInternal) {
        shell.openExternal(url).catch(() => {});
        return { action: "deny" };
      }
      return { action: "allow" };
    });

    const entry = {
      window: win,
      consoleLogs: [],
      networkLogs: [],
      createdAt: new Date().toISOString(),
    };
    webviewSessions.set(id, entry);
    if (!defaultWebviewId) {
      defaultWebviewId = id;
    }

    const session = win.webContents.session;
    // Capture the webContentsId now — before the window can be destroyed —
    // so the onCompleted filter never touches a dead webContents object.
    const webContentsId = win.webContents.id;
    const onCompleted = (details) => {
      if (details.webContentsId !== webContentsId) return;
      entry.networkLogs.push({
        url: details.url,
        statusCode: details.statusCode,
        method: details.method,
        timestamp: new Date().toISOString(),
      });
      if (entry.networkLogs.length > 500) {
        entry.networkLogs.shift();
      }
    };
    session.webRequest.onCompleted(onCompleted);

    const onConsoleMessage = (_event, level, message, line, sourceId) => {
      entry.consoleLogs.push({
        level,
        message,
        line,
        sourceId,
        timestamp: new Date().toISOString(),
      });
      if (entry.consoleLogs.length > 500) {
        entry.consoleLogs.shift();
      }
    };
    win.webContents.on("console-message", onConsoleMessage);

    win.on("closed", () => {
      // Remove the session-level network listener so it never fires on a dead window.
      // webRequest.onCompleted(null) clears the listener for this session.
      try {
        session.webRequest.onCompleted(null);
      } catch (_) {}
      webviewSessions.delete(id);
      if (defaultWebviewId === id) {
        defaultWebviewId = null;
      }
    });

    await win.loadURL(url);
    return {
      success: true,
      data: {
        webviewId: id,
        url,
        title: win.webContents.getTitle(),
      },
    };
  }

  const id = payload.webviewId || defaultWebviewId;
  if (!id || !webviewSessions.has(id)) {
    return { success: false, error: "No active webview session" };
  }
  const entry = webviewSessions.get(id);
  const win = entry.window;
  if (!win || win.isDestroyed()) {
    return { success: false, error: "Webview session is no longer available" };
  }

  if (action === "snapshot") {
    const maxHtmlChars = Number(payload.maxHtmlChars) || 80000;
    const maxTextChars = Number(payload.maxTextChars) || 12000;
    const html = await win.webContents.executeJavaScript(
      "document.documentElement.outerHTML",
    );
    const text = await win.webContents.executeJavaScript(
      "document.body ? document.body.innerText : ''",
    );
    return {
      success: true,
      data: {
        webviewId: id,
        url: win.webContents.getURL(),
        title: win.webContents.getTitle(),
        html: typeof html === "string" ? html.slice(0, maxHtmlChars) : "",
        text: typeof text === "string" ? text.slice(0, maxTextChars) : "",
      },
    };
  }

  if (action === "execute") {
    const script = payload.script;
    if (typeof script !== "string" || script.length === 0) {
      return { success: false, error: "script is required for execute" };
    }
    const result = await win.webContents.executeJavaScript(script);
    return {
      success: true,
      data: {
        webviewId: id,
        url: win.webContents.getURL(),
        result,
      },
    };
  }

  if (action === "get_console") {
    const limit = Number(payload.limit) || 100;
    const logs = entry.consoleLogs.slice(-limit);
    if (payload.clearAfterRead) {
      entry.consoleLogs.length = 0;
    }
    return { success: true, data: { webviewId: id, logs } };
  }

  if (action === "get_network") {
    const limit = Number(payload.limit) || 100;
    const logs = entry.networkLogs.slice(-limit);
    if (payload.clearAfterRead) {
      entry.networkLogs.length = 0;
    }
    return { success: true, data: { webviewId: id, logs } };
  }

  return { success: false, error: `Unknown webview action: ${action}` };
}

// Minimal window setup - just load the UI
function createMainWindow() {
  const preloadPath = path.join(__dirname, "preload.cjs");
  console.log(`[Electron] Preload script path: ${preloadPath}`);

  // Platform-specific window configuration
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  const baseConfig = {
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  };

  // macOS: Use native traffic lights with custom styling
  const macConfig = {
    ...baseConfig,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    transparent: true, // Enable window transparency for Liquid Glass
    backgroundColor: "#00000000", // Fully transparent background
    vibrancy: "under-window", // macOS native blur of desktop behind window
    visualEffectState: "active", // Keep blur active even when window loses focus
  };

  // Windows: Use native caption buttons with overlay
  // Windows: Use theme-aware colors for titlebar overlay
  const isDarkMode = nativeTheme.shouldUseDarkColors;
  const windowsConfig = {
    ...baseConfig,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: isDarkMode ? "#1C1C1E" : "#F5F5F7", // Dark or light background based on theme
      symbolColor: isDarkMode ? "#FFFFFF" : "#000000", // White icons in dark, black icons in light
      height: 52, // Match tab bar height
    },
    transparent: false, // Use solid background on Windows
    backgroundColor: isDarkMode ? "#1C1C1E" : "#F5F5F7", // Match titlebar color
  };

  // Linux: Simple frameless with transparency
  const linuxConfig = {
    ...baseConfig,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
  };

  mainWindow = new BrowserWindow(
    isMac ? macConfig : isWindows ? windowsConfig : linuxConfig
  );

  // Hide default menu
  Menu.setApplicationMenu(null);

  // Update Windows titlebar colors when theme changes
  if (isWindows) {
    nativeTheme.on('updated', () => {
      const isDarkMode = nativeTheme.shouldUseDarkColors;
      mainWindow.setTitleBarOverlay({
        color: isDarkMode ? "#1C1C1E" : "#F5F5F7",
        symbolColor: isDarkMode ? "#FFFFFF" : "#000000",
        height: 52,
      });
    });
  }

  // Enable context menu for text inputs (copy/paste/etc)
  mainWindow.webContents.on('context-menu', (event, params) => {
    const { selectionText, isEditable, inputFieldType } = params;
    
    // Only show menu for editable fields (inputs, textareas) or when text is selected
    if (!isEditable && !selectionText) return;
    
    const menu = Menu.buildFromTemplate([
      ...(selectionText ? [{
        label: 'Copy',
        role: 'copy',
        accelerator: 'CmdOrCtrl+C'
      }] : []),
      ...(isEditable ? [
        {
          label: 'Cut',
          role: 'cut',
          accelerator: 'CmdOrCtrl+X',
          enabled: !!selectionText
        },
        {
          label: 'Paste',
          role: 'paste',
          accelerator: 'CmdOrCtrl+V'
        }
      ] : []),
      ...(isEditable && selectionText ? [
        { type: 'separator' },
        {
          label: 'Select All',
          role: 'selectAll',
          accelerator: 'CmdOrCtrl+A'
        }
      ] : [])
    ]);
    
    menu.popup();
  });


  const uiUrl = IS_PRODUCTION ? `http://localhost:${GATEWAY_PORT}` : UI_DEV_URL;

  const loadStartTime = Date.now();
  console.log(`[Electron] Loading UI from: ${uiUrl} at ${new Date(loadStartTime).toISOString()}`);

  // Add error handler for load failures
  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedUrl) => {
      console.error(
        `[Electron] Failed to load UI: ${errorCode} - ${errorDescription}`,
      );
      console.error(`[Electron] Attempted URL: ${validatedUrl || uiUrl}`);
      console.error(
        `[Electron] Is Gateway running? Check port ${GATEWAY_PORT}`,
      );
    },
  );

  // Capture preload script errors (often the cause of blank window)
  mainWindow.webContents.on("preload-error", (event, preloadPath, error) => {
    console.error("[Electron] Preload script error:", preloadPath, error);
  });

  // Capture renderer process crashes
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    console.error("[Electron] Render process gone:", details.reason, details);
  });

  // Forward renderer console to terminal (helps debug when window is blank)
  const openDevTools = process.env.ELECTRON_OPEN_DEVTOOLS === "1";
  if (openDevTools) {
    console.log("[Electron] Opening DevTools (ELECTRON_OPEN_DEVTOOLS=1)");
    mainWindow.webContents.openDevTools();
  }
  mainWindow.webContents.on("console-message", (event, level, message) => {
    const levelName = ["verbose", "info", "warning", "error"][level] || "log";
    if (levelName === "error" || levelName === "warning" || openDevTools) {
      try {
        console.log(`[Renderer ${levelName}]`, message);
      } catch (err) {
        // EPIPE can occur when stdout is disconnected (e.g. launched from GUI)
        if (err?.code !== "EPIPE") throw err;
      }
    }
  });

  mainWindow.loadURL(uiUrl).catch((err) => {
    console.error("[Electron] loadURL failed:", err);
  });

  // Track page load timing
  mainWindow.webContents.on('did-start-loading', () => {
    console.log(`[Electron] Page started loading at +${Date.now() - loadStartTime}ms`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[Electron] Page finished loading at +${Date.now() - loadStartTime}ms`);
  });

  mainWindow.webContents.on('dom-ready', () => {
    console.log(`[Electron] DOM ready at +${Date.now() - loadStartTime}ms`);
  });

  // Intercept window.open() calls from mini-app iframes (target="_blank" links, etc.)
  // and open them in the system default browser instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Allow internal gateway URLs to open normally (e.g. webview windows)
    const isInternal =
      url.startsWith(`http://localhost:${GATEWAY_PORT}`) ||
      url.startsWith(`http://127.0.0.1:${GATEWAY_PORT}`);
    if (!isInternal) {
      shell.openExternal(url).catch((err) => {
        console.error(`[Electron] Failed to open external URL: ${url}`, err);
      });
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Keep DevTools development-only, or when ELECTRON_OPEN_DEVTOOLS=1 for debugging
  if (!IS_PRODUCTION || openDevTools) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
//  Gateway Process Supervisor
//
//  Manages the Gateway subprocess lifecycle with:
//  - Auto-restart with exponential backoff
//  - Circuit breaker (max 5 restarts in 5 minutes)
//  - HTTP health probes (ping /health every 10s)
//  - Tiered user notifications (silent → banner → dialog)
// ---------------------------------------------------------------------------

// Pure logic functions — imported from separate file for unit testing
const {
  calculateBackoff,
  isCircuitBroken,
  pruneTimestamps,
  getNotificationType,
  shouldKillProcess,
  isValidTransition,
} = require("./supervisor-logic.cjs");

class GatewayProcessSupervisor {
  constructor(options) {
    this.gatewayScript = options.gatewayScript;
    this.electronNodePath = options.electronNodePath;
    this.gatewayEnv = options.gatewayEnv;
    this.port = options.port;
    this.customKeysStorage = options.customKeysStorage;

    // State
    this.state = "stopped";
    this.process = null;
    this.restartCount = 0;
    this.restartTimestamps = [];
    this.healthCheckTimer = null;
    this.healthFailures = 0;
    this.backoffTimer = null;
    this.isStopping = false;

    // Config
    this.BACKOFF_BASE_MS = 500;
    this.BACKOFF_MAX_MS = 30000;
    this.CIRCUIT_BREAKER_MAX = 5;
    this.CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;
    this.HEALTH_INTERVAL_MS = 10000;
    this.HEALTH_FAILURE_THRESHOLD = 5;
    this.SILENT_RESTART_THRESHOLD = 2;
    this.BANNER_RESTART_THRESHOLD = 4;
  }

  getProcess() {
    return this.process;
  }

  _transitionTo(newState) {
    if (!isValidTransition(this.state, newState)) {
      console.warn(`[Supervisor] Invalid transition: ${this.state} → ${newState}`);
      return;
    }
    console.log(`[Supervisor] ${this.state} → ${newState}`);
    this.state = newState;
  }

  async start() {
    this.isStopping = false;
    this._transitionTo("starting");
    this._killOrphans();
    this._spawnProcess();
    await this._waitForReady();
    this._transitionTo("running");
    this._startHealthCheck();
  }

  stop() {
    this.isStopping = true;
    this._stopHealthCheck();
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.process) {
      console.log("[Supervisor] Stopping Gateway...");
      this.process.kill("SIGTERM");
      this.process = null;
      gatewayProcess = null;
    }
    this._transitionTo("stopped");
  }

  _killOrphans() {
    try {
      console.log("[Supervisor] Checking for orphaned Gateway processes...");
      
      if (process.platform === "win32") {
        // Windows: Use netstat to find PIDs listening on the port
        try {
          const output = execSync(`netstat -ano | findstr :${this.port}`, {
            encoding: "utf8",
            timeout: 5000,
          });
          
          const lines = output.trim().split("\n");
          for (const line of lines) {
            const match = line.match(/LISTENING\s+(\d+)/);
            if (match) {
              const pid = match[1];
              console.log(`[Supervisor] Found orphaned process ${pid} on port ${this.port}`);
              execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 });
              // Brief delay for cleanup
              const start = Date.now();
              while (Date.now() - start < 500) {
                // Busy wait
              }
              console.log("[Supervisor] Orphaned process killed");
            }
          }
        } catch (e) {
          // No process on port or command failed — good
        }
      } else {
        // Unix (macOS, Linux): Use lsof
        try {
          const pid = execSync(`lsof -ti:${this.port}`, { encoding: "utf8" }).trim();
          if (pid) {
            console.log(`[Supervisor] Found orphaned process ${pid} on port ${this.port}`);
            execSync(`kill -9 ${pid}`);
            execSync("sleep 0.5");
            console.log("[Supervisor] Orphaned process killed");
          }
        } catch (e) {
          // No process on port — good
        }
      }
    } catch (error) {
      console.warn("[Supervisor] Cleanup warning:", error.message);
    }
  }

  _spawnProcess() {
    console.log(`[Supervisor] Starting Gateway on port ${this.port}...`);

    this.process = spawn(this.electronNodePath, [this.gatewayScript], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: this.gatewayEnv,
    });

    // Update module-level reference for backward compatibility
    gatewayProcess = this.process;
    if (setGatewayProcess) {
      setGatewayProcess(this.process);
    }

    this._setupIpcHandlers();

    this.process.on("error", (err) => this._onProcessError(err));
    this.process.on("exit", (code) => this._onProcessExit(code));
  }

  _setupIpcHandlers() {
    const proc = this.process;
    const storage = this.customKeysStorage;

    proc.on("message", async (msg) => {
      // Guard: if process was replaced during async handling, skip
      if (proc !== this.process) return;

      if (isRequestKeysMessage(msg)) {
        console.log("[Electron] Gateway requested keys:", msg.keys);

        const resolvedKeys = {};
        for (const keyName of msg.keys || []) {
          try {
            const value = await storage.getKeyByName(keyName);
            if (value !== null) {
              resolvedKeys[keyName] = value;
              console.log(`[Electron]   ✓ Resolved ${keyName}`);
            } else {
              const envFallback = process.env[keyName];
              if (envFallback) {
                resolvedKeys[keyName] = envFallback;
                console.log(`[Electron]   ✓ Resolved ${keyName} from env fallback`);
              } else {
                console.log(`[Electron]   ✗ Key ${keyName} not found`);
              }
            }
          } catch (error) {
            console.error(`[Electron]   ✗ Error resolving ${keyName}:`, error);
          }
        }

        // Include OAuth tokens if available
        const oauthTokens = {};
        try {
          const { getOAuthTokenStorage } =
            await import("../../dist/electron/electron/ipc/oauth.js");
          const oauthStorage = getOAuthTokenStorage();

          if (oauthStorage) {
            const openaiToken = oauthStorage.getTokenByProvider("openai");
            if (openaiToken && !oauthStorage.isTokenExpired(openaiToken)) {
              oauthTokens.openai = {
                accessToken: openaiToken.accessToken,
                expiresAt: openaiToken.expiresAt,
              };
              console.log("[Electron]   ✓ OpenAI OAuth token available");
            }

            const claudeToken = oauthStorage.getTokenByProvider("anthropic");
            if (claudeToken && !oauthStorage.isTokenExpired(claudeToken)) {
              console.log(`[Electron]   Claude OAuth token details: length=${claudeToken.accessToken.length}, prefix=${claudeToken.accessToken.substring(0, 30)}...`);
              oauthTokens.anthropic = {
                accessToken: claudeToken.accessToken,
                expiresAt: claudeToken.expiresAt,
              };
              console.log("[Electron]   ✓ Claude OAuth token available");
            } else {
              if (!claudeToken) {
                console.log("[Electron]   ✗ No Claude OAuth token found");
              } else {
                console.log("[Electron]   ✗ Claude OAuth token expired");
              }
            }
          }
        } catch (error) {
          console.error("[Electron] Failed to load OAuth tokens:", error);
        }

        if (proc === this.process) {
          proc.send({
            type: "KEYS_RESPONSE",
            requestId: msg.requestId,
            keys: resolvedKeys,
            // Always send (possibly {}) so gateway clears stale oauth cache when tokens are missing/expired
            oauthTokens,
          });
        }
      } else if (isRequestPermissionMessage(msg)) {
        console.log("[Electron] Gateway requested permission:", msg.request);
        try {
          if (!requestPermissionFromGateway) {
            throw new Error("Permission IPC module not initialized");
          }
          const response = await requestPermissionFromGateway(msg.request);
          if (proc === this.process) {
            proc.send({ type: "PERMISSION_RESPONSE", requestId: msg.requestId, response });
          }
        } catch (error) {
          console.error("[Electron]   ✗ Error requesting permission:", error);
          if (proc === this.process) {
            proc.send({ type: "PERMISSION_RESPONSE", requestId: msg.requestId, response: { approved: false } });
          }
        }
      } else if (isRequestWebviewTestMessage(msg)) {
        try {
          const response = await handleWebviewTestRequest(msg.request);
          if (proc === this.process) {
            proc.send({ type: "WEBVIEW_TEST_RESPONSE", requestId: msg.requestId, response });
          }
        } catch (error) {
          if (proc === this.process) {
            proc.send({
              type: "WEBVIEW_TEST_RESPONSE",
              requestId: msg.requestId,
              response: { success: false, error: error instanceof Error ? error.message : String(error) },
            });
          }
        }
      } else if (msg.type === "CUSTOM_KEYS_LIST") {
        try {
          console.log(`[Electron] Received CUSTOM_KEYS_LIST request: ${msg.requestId}`);
          const keys = await storage.listKeys();
          console.log(`[Electron] Loaded ${keys.length} keys from storage:`, keys.map(k => k.name));
          if (proc === this.process) {
            proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, keys });
            console.log(`[Electron] Sent CUSTOM_KEYS_RESPONSE with ${keys.length} keys`);
          }
        } catch (error) {
          console.error("[Electron] custom-keys:list error:", error);
          if (proc === this.process) proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
        }
      } else if (msg.type === "CUSTOM_KEYS_GET_BY_NAME") {
        try {
          console.log(`[Electron] Received CUSTOM_KEYS_GET_BY_NAME request: ${msg.requestId} for key: "${msg.name}"`);
          const value = await storage.getKeyByName(msg.name);
          const found = value ? "found" : "not found";
          const preview = value ? `${value.substring(0, 10)}...` : "null";
          console.log(`[Electron] Key "${msg.name}" ${found} (preview: ${preview})`);
          if (proc === this.process) {
            proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, value });
            console.log(`[Electron] Sent CUSTOM_KEYS_RESPONSE with value ${found}`);
          }
        } catch (error) {
          console.error("[Electron] custom-keys:get-by-name error:", error);
          if (proc === this.process) proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
        }
      } else if (msg.type === "CUSTOM_KEYS_ADD") {
        try {
          const key = await storage.addKey(msg.input);
          if (proc === this.process) proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, key });
        } catch (error) {
          console.error("[Electron] custom-keys:add error:", error);
          if (proc === this.process) proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
        }
      } else if (msg.type === "CUSTOM_KEYS_DELETE") {
        try {
          await storage.deleteKey(msg.keyId);
          if (proc === this.process) proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId });
        } catch (error) {
          console.error("[Electron] custom-keys:delete error:", error);
          if (proc === this.process) proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  }

  _onProcessError(err) {
    console.error("[Supervisor] Gateway failed to start:", err);
  }

  _onProcessExit(code) {
    console.log(`[Supervisor] Gateway exited with code: ${code}`);
    this._stopHealthCheck();
    this.process = null;
    gatewayProcess = null;

    if (this.isStopping) return;

    this._scheduleRestart();
  }

  _scheduleRestart() {
    const now = Date.now();
    this.restartTimestamps.push(now);
    this.restartTimestamps = pruneTimestamps(this.restartTimestamps, now, this.CIRCUIT_BREAKER_WINDOW_MS);

    if (isCircuitBroken(this.restartTimestamps, now, this.CIRCUIT_BREAKER_WINDOW_MS, this.CIRCUIT_BREAKER_MAX)) {
      // Force state to backoff first so backoff→failed is valid
      if (this.state === "running" || this.state === "starting") {
        this.state = "backoff";
        console.log(`[Supervisor] ${this.state} → backoff (forced for circuit breaker)`);
      }
      this._transitionTo("failed");
      this._notifyUser("circuit_broken");
      return;
    }

    this.restartCount++;
    const delay = calculateBackoff(this.restartCount - 1, this.BACKOFF_BASE_MS, this.BACKOFF_MAX_MS);

    console.log(`[Supervisor] Scheduling restart #${this.restartCount} in ${delay}ms`);

    // Transition to backoff
    if (this.state !== "backoff") {
      if (this.state === "running" || this.state === "starting") {
        this._transitionTo("backoff");
      }
    }

    this._notifyUser(this.restartCount);

    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      if (this.isStopping) return;
      this._performRestart();
    }, delay);
  }

  async _performRestart() {
    this._transitionTo("starting");
    this._killOrphans();
    this._spawnProcess();
    await this._waitForReady();
    if (this.isStopping) return;
    this._transitionTo("running");
    this.restartCount = 0; // Reset on successful start
    this._startHealthCheck();

    // Notify UI that gateway is back
    this._sendStatusToRenderer("running", "Gateway reconnected");
  }

  _startHealthCheck() {
    this.healthFailures = 0;
    this._stopHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            this._onHealthCheckResult(parsed.status === "ok");
          } catch {
            this._onHealthCheckResult(false);
          }
        });
      });
      req.on("error", () => this._onHealthCheckResult(false));
      req.setTimeout(5000, () => {
        req.destroy();
        this._onHealthCheckResult(false);
      });
    }, this.HEALTH_INTERVAL_MS);
  }

  _stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  _onHealthCheckResult(ok) {
    const result = shouldKillProcess(this.healthFailures, ok, this.HEALTH_FAILURE_THRESHOLD);
    this.healthFailures = result.newCount;

    if (result.shouldKill) {
      console.error(`[Supervisor] Health check failed ${this.HEALTH_FAILURE_THRESHOLD} times, killing gateway`);
      this._stopHealthCheck();
      if (this.process) {
        this.process.kill("SIGKILL");
        // _onProcessExit will handle restart scheduling
      }
    } else if (!ok) {
      console.warn(`[Supervisor] Health check failed (${this.healthFailures}/${this.HEALTH_FAILURE_THRESHOLD})`);
    }
  }

  _notifyUser(restartCountOrEvent) {
    if (restartCountOrEvent === "circuit_broken") {
      // Show modal dialog
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const options = {
        type: "error",
        title: "Gateway Failed",
        message: "The Gateway process has failed repeatedly and cannot recover.",
        detail: "The internal service that powers Paprwork has crashed multiple times. You can try restarting it, or quit the application.",
        buttons: ["Restart", "Quit"],
        defaultId: 0,
        cancelId: 1,
      };

      const showDialog = win
        ? dialog.showMessageBox(win, options)
        : dialog.showMessageBox(options);

      showDialog.then(({ response }) => {
        if (response === 0) {
          // Reset and try again
          this.restartTimestamps = [];
          this.restartCount = 0;
          this.state = "failed"; // Ensure we can transition failed→starting
          this._performRestart();
        } else {
          app.quit();
        }
      });
      return;
    }

    const count = restartCountOrEvent;
    const type = getNotificationType(count, this.SILENT_RESTART_THRESHOLD, this.BANNER_RESTART_THRESHOLD);

    if (type === "silent") {
      console.log(`[Supervisor] Silent restart #${count}`);
      return;
    }

    if (type === "banner") {
      this._sendStatusToRenderer("restarting", `Gateway is restarting (attempt ${count})...`);
    }
  }

  _sendStatusToRenderer(status, message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gateway:status", { status, message });
    }
  }

  _waitForReady(maxAttempts = 20, intervalMs = 500) {
    return new Promise((resolve) => {
      let attempts = 0;
      let resolved = false;

      const check = setInterval(() => {
        if (this.isStopping) {
          clearInterval(check);
          resolve();
          return;
        }
        attempts++;
        const req = http.get(`http://localhost:${this.port}/`, (res) => {
          if (resolved) return;
          resolved = true;
          clearInterval(check);
          console.log(`[Supervisor] Gateway is ready (status: ${res.statusCode})`);
          resolve();
        });
        req.on("error", () => {
          if (resolved) return;
          if (attempts >= maxAttempts) {
            resolved = true;
            clearInterval(check);
            console.error(`[Supervisor] Gateway failed to respond after ${maxAttempts} attempts`);
            resolve();
          } else {
            console.log(`[Supervisor] Waiting for Gateway... (${attempts}/${maxAttempts})`);
          }
        });
        req.end();
      }, intervalMs);
    });
  }
}

// ---------------------------------------------------------------------------
//  Auto-Updater
//
//  Checks GitHub Releases for new versions on launch and periodically.
//  Sends status to renderer via IPC so the UI can show an update banner.
// ---------------------------------------------------------------------------

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // We handle logging ourselves

  autoUpdater.on("checking-for-update", () => {
    console.log("[AutoUpdater] Checking for updates...");
    sendUpdateStatus("checking");
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[AutoUpdater] Update available: v${info.version}`);
    sendUpdateStatus("available", { version: info.version, releaseNotes: info.releaseNotes });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[AutoUpdater] App is up to date");
    sendUpdateStatus("not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus("downloading", { percent: Math.round(progress.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[AutoUpdater] Update downloaded: v${info.version}`);
    sendUpdateStatus("ready", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    console.error("[AutoUpdater] Error:", err.message);
    sendUpdateStatus("error", { error: err.message });
  });

  // IPC: renderer can request "install now" (quit & install)
  ipcMain.on("updater:install", () => {
    console.log("[AutoUpdater] User requested install, quitting and installing...");
    autoUpdater.quitAndInstall(false, true);
  });

  // IPC: renderer can manually trigger a check
  ipcMain.on("updater:check", () => {
    console.log("[AutoUpdater] Manual check requested");
    
    // Check if running in development/unpackaged mode
    if (!app.isPackaged) {
      console.log("[AutoUpdater] Skipping check - app is not packaged");
      sendUpdateStatus("error", { 
        error: "Updates are only available in packaged builds. Running from source doesn't support auto-updates." 
      });
      return;
    }
    
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[AutoUpdater] Manual check failed:", err.message);
      sendUpdateStatus("error", { error: err.message });
    });
  });

  // Check on launch (after a short delay to not block startup)
  setTimeout(() => {
    // Skip auto-check in development mode
    if (!app.isPackaged) {
      console.log("[AutoUpdater] Skipping initial check - app is not packaged");
      return;
    }
    
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[AutoUpdater] Initial check failed:", err.message);
      sendUpdateStatus("error", { error: err.message });
    });
  }, 5000);

  // Check every 4 hours
  setInterval(() => {
    // Skip auto-check in development mode
    if (!app.isPackaged) {
      return;
    }
    
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[AutoUpdater] Periodic check failed:", err.message);
    });
  }, 4 * 60 * 60 * 1000);
}

function sendUpdateStatus(status, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updater:status", { status, ...data });
  }
}

let supervisor = null;

// App lifecycle
// ---------------------------------------------------------------------------
//  System Integration for Mini-Apps
//
//  Generic system:invoke handler that allows mini-apps to call whitelisted
//  Electron APIs like shell.openExternal, dialog.showSaveDialog, etc.
// ---------------------------------------------------------------------------

function initializeSystemInvokeHandler(mainWindow) {
  const { Notification, clipboard } = require('electron');
  const fs = require('fs/promises');
  const os = require('os');
  
  // Whitelist of allowed Electron APIs
  const ALLOWED_APIS = {
    'shell.openExternal': async (url) => {
      await shell.openExternal(url);
      return { success: true };
    },
    
    'shell.showItemInFolder': async (fullPath) => {
      shell.showItemInFolder(fullPath);
      return { success: true };
    },
    
    'shell.trashItem': async (fullPath) => {
      await shell.trashItem(fullPath);
      return { success: true };
    },
    
    'dialog.showSaveDialog': async (options) => {
      const result = await dialog.showSaveDialog(mainWindow, options);
      if (result.canceled) {
        return { canceled: true };
      }
      
      // If content provided, write the file
      if (options.content) {
        await fs.writeFile(result.filePath, options.content);
      }
      
      return { filePath: result.filePath, success: true };
    },
    
    'dialog.showOpenDialog': async (options) => {
      const result = await dialog.showOpenDialog(mainWindow, options);
      if (result.canceled) {
        return { canceled: true };
      }
      return { filePaths: result.filePaths, success: true };
    },
    
    'dialog.showMessageBox': async (options) => {
      const result = await dialog.showMessageBox(mainWindow, options);
      return { response: result.response, checkboxChecked: result.checkboxChecked };
    },
    
    'clipboard.writeText': async (text) => {
      clipboard.writeText(text);
      return { success: true };
    },
    
    'clipboard.readText': async () => {
      return { text: clipboard.readText() };
    },
    
    'notification.show': async (options) => {
      const notification = new Notification({
        title: options.title || 'Notification',
        body: options.body || '',
        urgency: options.urgency || 'normal'
      });
      notification.show();
      return { success: true };
    },
    
    'app.getPath': async (name) => {
      return { path: app.getPath(name) };
    },
    
    'chat.open': async (options) => {
      // Send message to renderer to open a new chat tab
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chat:open', {
          message: options?.message || '',
          model: options?.model || null,
          provider: options?.provider || null,
        });
        return { success: true };
      }
      throw new Error('Main window not available');
    },
  };

  // Register IPC handler
  ipcMain.handle('system:invoke', async (event, method, args) => {
    try {
      console.log(`[Electron] system:invoke: ${method}`, args);
      
      // Check if method is whitelisted
      const handler = ALLOWED_APIS[method];
      if (!handler) {
        const allowedMethods = Object.keys(ALLOWED_APIS).join(', ');
        throw new Error(`Electron API not allowed: ${method}. Whitelist: ${allowedMethods}`);
      }
      
      // Call the handler with args (handle both array and single object)
      const argsArray = Array.isArray(args) ? args : [args];
      const result = await handler(...argsArray);
      return result;
    } catch (error) {
      console.error(`[Electron] system:invoke error:`, error);
      throw error;
    }
  });
  
  console.log('[Electron] System invoke handler initialized ✓');
}

// ---------------------------------------------------------------------------
//  App Lifecycle
// ---------------------------------------------------------------------------

// Storage instances (shared between app.whenReady and second-instance handler)
let customKeysStorage;
let keyPermissionsStorage;
let settingsStorage;

// Single instance lock - prevent multiple instances on Windows/Linux
// When a second instance tries to start, send its command line args to the first instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[Electron] Another instance is already running, quitting');
  app.quit();
} else {
  // Handle second instance attempting to launch (e.g., from deep link on Windows)
  app.on('second-instance', async (event, commandLine, workingDirectory) => {
    console.log('[Electron] Second instance detected, focusing existing window');
    
    // Focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    
    // Check if the second instance was launched with a deep link
    const url = commandLine.find(arg => arg.startsWith('papr://'));
    if (url && handlePaprAuthCallback && customKeysStorage && settingsStorage) {
      console.log('[Electron] Second instance opened with deep link:', url);
      await handlePaprAuthCallback(url, customKeysStorage, settingsStorage);
    }
  });
}

app.whenReady().then(async () => {
  console.log("[Electron] App ready");

  // Register custom URL protocol for papr:// deep links
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('papr', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('papr');
  }

  // Load ESM modules first
  await loadESMModules();

  // Initialize storage and IPC (use outer scope variables for second-instance handler)
  customKeysStorage = new CustomKeysStorage();
  keyPermissionsStorage = new KeyPermissionsStorage();
  settingsStorage = new SettingsStorage(undefined, {
    defaultTelemetryEnabled: app.isPackaged,
  });

  await customKeysStorage.initialize();
  // Note: KeyPermissionsStorage and SettingsStorage auto-initialize via electron-store

  if (initializeTelemetryIPC) {
    initializeTelemetryIPC(settingsStorage);
  }
  if (TelemetryClientClass && isTelemetrySendingEnabledFn) {
    telemetryClientInstance = new TelemetryClientClass({
      getEffectiveEnabled: () =>
        isTelemetrySendingEnabledFn(() =>
          settingsStorage.getTelemetryEnabled(),
        ),
      getAnonymousInstallId: () =>
        settingsStorage.getOrCreateTelemetryInstallId(),
      appVersion: app.getVersion(),
    });
    telemetryClientInstance.trackFireAndForget("paprwork_app_started");
  }

  initializeCustomKeysIPC(customKeysStorage);

  // Initialize OAuth IPC handlers (pass customKeysStorage for syncing)
  await initializeOAuthIPC(customKeysStorage);

  // Initialize Papr Login IPC handlers
  initializePaprLoginIPC(customKeysStorage, settingsStorage);

  // Initialize Python dependencies IPC handlers
  initializePythonDepsIPC();

  // Build gateway environment (telemetry flags align with main-process resolution)
  const gatewayTelemetryOn =
    isTelemetrySendingEnabledFn != null
      ? isTelemetrySendingEnabledFn(() =>
          settingsStorage.getTelemetryEnabled(),
        )
      : settingsStorage.getTelemetryEnabled();
  const gatewayEnv = {
    ...process.env,
    GATEWAY_PORT: String(GATEWAY_PORT),
    NODE_ENV: IS_PRODUCTION ? "production" : "development",
    ELECTRON_RUN_AS_NODE: "1",
    PAPRWORK_TELEMETRY_ENABLED: gatewayTelemetryOn ? "true" : "false",
    PAPRWORK_TELEMETRY_ANONYMOUS_ID:
      settingsStorage.getOrCreateTelemetryInstallId(),
    PAPRWORK_APP_VERSION: app.getVersion(),
  };
  if (IS_PRODUCTION) {
    const asarUnpacked = path.join(__dirname, "../..").replace("app.asar", "app.asar.unpacked");
    const esbuildBinName = process.platform === "win32" ? "esbuild.exe" : "esbuild";
    const esbuildBin = path.join(asarUnpacked, "node_modules/@esbuild", `${process.platform}-${process.arch}`, "bin", esbuildBinName);
    if (require("fs").existsSync(esbuildBin)) {
      gatewayEnv.ESBUILD_BINARY_PATH = esbuildBin;
      console.log(`[Electron] esbuild binary: ${esbuildBin}`);
    }
  }

  // Start Gateway with process supervisor
  supervisor = new GatewayProcessSupervisor({
    gatewayScript: path.join(__dirname, "../../dist/gateway/index.js"),
    electronNodePath: process.execPath,
    gatewayEnv,
    port: GATEWAY_PORT,
    customKeysStorage,
  });

  await supervisor.start();
  createMainWindow();
  setupAutoUpdater();

  // Initialize permissions IPC after window is created
  initializePermissionsIPC(keyPermissionsStorage, settingsStorage, mainWindow);

  // Initialize Ollama IPC handlers
  if (initializeOllamaIPC) {
    initializeOllamaIPC(mainWindow);
  }

  // Initialize system:invoke handler for mini-app system integration
  initializeSystemInvokeHandler(mainWindow);

  // Handle deep links for Papr auth callback (papr://auth/callback?...)
  // This handles the case when the app is already running
  app.on('open-url', async (event, url) => {
    event.preventDefault();
    console.log('[Electron] Received deep link:', url);
    if (handlePaprAuthCallback) {
      await handlePaprAuthCallback(url, customKeysStorage, settingsStorage);
    }
  });

  // Handle deep links when app is opened from a URL (macOS/Windows)
  // Check if the app was opened with a URL argument
  if (process.platform === 'darwin') {
    // macOS - URL is passed via 'open-url' event
    // Already handled above
  } else {
    // Windows/Linux - URL is passed as command line argument
    const url = process.argv.find(arg => arg.startsWith('papr://'));
    if (url && handlePaprAuthCallback) {
      console.log('[Electron] App opened with deep link:', url);
      await handlePaprAuthCallback(url, customKeysStorage, settingsStorage);
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  // System power state monitoring (sleep/wake/lock/unlock)
  // Works on macOS, Windows, and Linux
  powerMonitor.on('suspend', () => {
    console.log('[Electron] System suspending (sleep)');
    
    // Notify Gateway that system is going to sleep
    if (gatewayProcess && !gatewayProcess.killed) {
      try {
        gatewayProcess.send({
          type: 'SYSTEM_SUSPEND',
          timestamp: Date.now()
        });
      } catch (err) {
        console.warn('[Electron] Failed to notify Gateway of suspend:', err.message);
      }
    }

    // Notify renderer (UI) that system is suspending
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:suspend', { timestamp: Date.now() });
    }

    // Track telemetry
    if (telemetryClientInstance) {
      telemetryClientInstance.trackFireAndForget('paprwork_system_suspend');
    }
  });

  powerMonitor.on('resume', () => {
    console.log('[Electron] System resumed (wake)');
    
    // Notify Gateway that system woke up
    if (gatewayProcess && !gatewayProcess.killed) {
      try {
        gatewayProcess.send({
          type: 'SYSTEM_RESUME',
          timestamp: Date.now()
        });
      } catch (err) {
        console.warn('[Electron] Failed to notify Gateway of resume:', err.message);
      }
    }

    // Notify renderer (UI) that system resumed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:resume', { timestamp: Date.now() });
    }

    // Track telemetry
    if (telemetryClientInstance) {
      telemetryClientInstance.trackFireAndForget('paprwork_system_resume');
    }
  });

  // Lock screen events (macOS, Windows only)
  powerMonitor.on('lock-screen', () => {
    console.log('[Electron] Screen locked');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:lock-screen', { timestamp: Date.now() });
    }
  });

  powerMonitor.on('unlock-screen', () => {
    console.log('[Electron] Screen unlocked');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:unlock-screen', { timestamp: Date.now() });
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  console.log("[Electron] App quitting...");
  if (telemetryClientInstance) {
    telemetryClientInstance.trackFireAndForget("paprwork_app_quit");
  }
  // Cleanup OAuth servers before stopping gateway
  if (cleanupOAuthServers) {
    cleanupOAuthServers();
  }
  // Cleanup Papr login callback server
  if (cleanupPaprLogin) {
    cleanupPaprLogin();
  }
  // Cleanup Ollama (stop managed instance)
  if (cleanupOllama) {
    await cleanupOllama();
  }
  if (supervisor) supervisor.stop();
});

process.on("SIGINT", () => {
  console.log("[Electron] Received SIGINT, shutting down...");
  if (supervisor) supervisor.stop();
  app.quit();
});

process.on("SIGTERM", () => {
  console.log("[Electron] Received SIGTERM, shutting down...");
  if (supervisor) supervisor.stop();
  app.quit();
});
