/**
 * Electron Shell
 *
 * Minimal Electron wrapper that loads the UI from the Gateway
 * CommonJS format - Electron's require() is more reliable than ESM
 */

const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

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

  // Import Ollama IPC module
  const ollamaIpcModule =
    await import("../../dist/electron/electron/electron/ipc/ollama.js");
  initializeOllamaIPC = ollamaIpcModule.initializeOllamaIPC;

  // Import Ollama Manager for cleanup
  const ollamaManagerModule =
    await import("../../dist/electron/electron/electron/services/OllamaManager.js");
  const ollamaManager = ollamaManagerModule.getOllamaManager();
  cleanupOllama = () => ollamaManager.cleanup();
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

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    transparent: true, // Enable window transparency for Liquid Glass
    backgroundColor: "#00000000", // Fully transparent background
    vibrancy: "under-window", // macOS native blur of desktop behind window
    visualEffectState: "active", // Keep blur active even when window loses focus
  });

  // Hide default menu
  Menu.setApplicationMenu(null);

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

// Launch Gateway as subprocess
function startGateway(customKeysStorage) {
  // Kill any orphaned Gateway processes first
  const { execSync } = require("child_process");
  try {
    console.log("[Electron] Checking for orphaned Gateway processes...");
    
    // Kill any process on Gateway port
    try {
      const pid = execSync(`lsof -ti:${GATEWAY_PORT}`, { encoding: "utf8" }).trim();
      if (pid) {
        console.log(`[Electron] Found orphaned process ${pid} on port ${GATEWAY_PORT}`);
        execSync(`kill -9 ${pid}`);
        // Wait a moment for port to be released
        execSync("sleep 0.5");
        console.log("[Electron] ✓ Orphaned process killed");
      }
    } catch (e) {
      // No process found - good!
      console.log("[Electron] ✓ Port ${GATEWAY_PORT} is free");
    }
  } catch (error) {
    console.warn("[Electron] Cleanup warning:", error.message);
  }

  // Gateway is compiled to dist/gateway/ from project root
  const gatewayScript = path.join(__dirname, "../../dist/gateway/index.js");

  console.log(`[Electron] Starting Gateway...`);
  console.log(`[Electron] Gateway path: ${gatewayScript}`);
  console.log(`[Electron] Gateway port: ${GATEWAY_PORT}`);
  console.log(`[Electron] Working directory: ${process.cwd()}`);

  // Use Electron's embedded Node.js to ensure version consistency (Node v24)
  const electronNodePath = process.execPath; // Path to electron binary

  // Resolve esbuild binary path for asar-unpacked native binary
  const gatewayEnv = {
    ...process.env,
    GATEWAY_PORT: String(GATEWAY_PORT),
    NODE_ENV: IS_PRODUCTION ? "production" : "development",
    ELECTRON_RUN_AS_NODE: "1", // Run Electron as Node.js
  };
  if (IS_PRODUCTION) {
    // esbuild's native binary is unpacked from asar but require.resolve
    // still points inside app.asar. Set ESBUILD_BINARY_PATH explicitly.
    const asarUnpacked = path.join(__dirname, "../..").replace("app.asar", "app.asar.unpacked");
    const esbuildBin = path.join(asarUnpacked, "node_modules/@esbuild", `${process.platform}-${process.arch}`, "bin/esbuild");
    if (require("fs").existsSync(esbuildBin)) {
      gatewayEnv.ESBUILD_BINARY_PATH = esbuildBin;
      console.log(`[Electron] esbuild binary: ${esbuildBin}`);
    }
  }

  gatewayProcess = spawn(electronNodePath, [gatewayScript], {
    stdio: ["inherit", "inherit", "inherit", "ipc"], // Enable IPC
    env: gatewayEnv,
  });

  // Set Gateway process reference for cache invalidation
  setGatewayProcess(gatewayProcess);

  // Set up IPC for Gateway communication
  gatewayProcess.on("message", async (msg) => {
    // Handle key resolution requests (existing)
    if (isRequestKeysMessage(msg)) {
      console.log("[Electron] Gateway requested keys:", msg.keys);

      const resolvedKeys = {};
      for (const keyName of msg.keys || []) {
        try {
          const value = await customKeysStorage.getKeyByName(keyName);
          if (value !== null) {
            resolvedKeys[keyName] = value;
            console.log(`[Electron]   ✓ Resolved ${keyName}`);
          } else {
            const envFallback = process.env[keyName];
            if (envFallback) {
              resolvedKeys[keyName] = envFallback;
              console.log(
                `[Electron]   ✓ Resolved ${keyName} from env fallback`,
              );
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
          // Check OpenAI OAuth token
          const openaiToken = oauthStorage.getTokenByProvider("openai");
          if (openaiToken && !oauthStorage.isTokenExpired(openaiToken)) {
            oauthTokens.openai = {
              accessToken: openaiToken.accessToken,
              expiresAt: openaiToken.expiresAt,
            };
            console.log("[Electron]   ✓ OpenAI OAuth token available");
          }

          // Check Claude OAuth token
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

      gatewayProcess.send({
        type: "KEYS_RESPONSE",
        requestId: msg.requestId,
        keys: resolvedKeys,
        oauthTokens:
          Object.keys(oauthTokens).length > 0 ? oauthTokens : undefined,
      });
    }

    // Handle permission requests from Gateway (new)
    else if (isRequestPermissionMessage(msg)) {
      console.log("[Electron] Gateway requested permission:", msg.request);

      try {
        if (!requestPermissionFromGateway) {
          throw new Error("Permission IPC module not initialized");
        }

        const response = await requestPermissionFromGateway(msg.request);

        gatewayProcess.send({
          type: "PERMISSION_RESPONSE",
          requestId: msg.requestId,
          response,
        });
      } catch (error) {
        console.error("[Electron]   ✗ Error requesting permission:", error);
        gatewayProcess.send({
          type: "PERMISSION_RESPONSE",
          requestId: msg.requestId,
          response: { approved: false },
        });
      }
    } else if (isRequestWebviewTestMessage(msg)) {
      try {
        const response = await handleWebviewTestRequest(msg.request);
        gatewayProcess.send({
          type: "WEBVIEW_TEST_RESPONSE",
          requestId: msg.requestId,
          response,
        });
      } catch (error) {
        gatewayProcess.send({
          type: "WEBVIEW_TEST_RESPONSE",
          requestId: msg.requestId,
          response: {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    // Handle custom keys requests from Gateway
    else if (msg.type === "CUSTOM_KEYS_LIST") {
      try {
        const keys = await customKeysStorage.listKeys();
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
          keys,
        });
      } catch (error) {
        console.error("[Electron] custom-keys:list error:", error);
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (msg.type === "CUSTOM_KEYS_GET_BY_NAME") {
      try {
        const value = await customKeysStorage.getKeyByName(msg.name);
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
          value,
        });
      } catch (error) {
        console.error("[Electron] custom-keys:get-by-name error:", error);
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (msg.type === "CUSTOM_KEYS_ADD") {
      try {
        const key = await customKeysStorage.addKey(msg.input);
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
          key,
        });
      } catch (error) {
        console.error("[Electron] custom-keys:add error:", error);
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (msg.type === "CUSTOM_KEYS_DELETE") {
      try {
        await customKeysStorage.deleteKey(msg.keyId);
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
        });
      } catch (error) {
        console.error("[Electron] custom-keys:delete error:", error);
        gatewayProcess.send({
          type: "CUSTOM_KEYS_RESPONSE",
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  gatewayProcess.on("error", (err) => {
    console.error("[Electron] Gateway failed to start:", err);
  });

  gatewayProcess.on("exit", (code) => {
    console.log(`[Electron] Gateway exited with code: ${code}`);
    if (code !== 0 && code !== null) {
      app.quit();
    }
  });
}

// Gracefully shutdown Gateway
function stopGateway() {
  if (gatewayProcess) {
    console.log("[Electron] Stopping Gateway...");
    gatewayProcess.kill("SIGTERM");
    gatewayProcess = null;
  }
}

// App lifecycle
app.whenReady().then(async () => {
  console.log("[Electron] App ready");

  // Load ESM modules first
  await loadESMModules();

  // Initialize storage and IPC
  const customKeysStorage = new CustomKeysStorage();
  const keyPermissionsStorage = new KeyPermissionsStorage();
  const settingsStorage = new SettingsStorage();

  await customKeysStorage.initialize();
  // Note: KeyPermissionsStorage and SettingsStorage auto-initialize via electron-store

  initializeCustomKeysIPC(customKeysStorage);

  // Initialize OAuth IPC handlers (pass customKeysStorage for syncing)
  await initializeOAuthIPC(customKeysStorage);

  // Start Gateway process
  startGateway(customKeysStorage);

  // Wait for Gateway to start (check if it's actually running)
  let attempts = 0;
  const maxAttempts = 20; // 10 seconds max
  let gatewayReady = false; // guard against multiple in-flight requests all resolving

  const checkGateway = setInterval(() => {
    attempts++;

    // Try to connect to Gateway
    const http = require("http");
    const req = http.get(`http://localhost:${GATEWAY_PORT}/`, (res) => {
      if (gatewayReady) return; // already handled — discard duplicate response
      gatewayReady = true;
      console.log(`[Electron] Gateway is ready (status: ${res.statusCode})`);
      clearInterval(checkGateway);
      createMainWindow();

      // Initialize permissions IPC after window is created
      initializePermissionsIPC(
        keyPermissionsStorage,
        settingsStorage,
        mainWindow,
      );

      // Initialize Ollama IPC handlers
      if (initializeOllamaIPC) {
        initializeOllamaIPC(mainWindow);
      }
    });

    req.on("error", (err) => {
      if (gatewayReady) return;
      if (attempts >= maxAttempts) {
        gatewayReady = true;
        console.error(
          `[Electron] Gateway failed to start after ${maxAttempts} attempts`,
        );
        clearInterval(checkGateway);
        // Try to create window anyway
        createMainWindow();
      } else {
        console.log(
          `[Electron] Waiting for Gateway... (${attempts}/${maxAttempts})`,
        );
      }
    });

    req.end();
  }, 500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
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
  // Cleanup OAuth servers before stopping gateway
  if (cleanupOAuthServers) {
    cleanupOAuthServers();
  }
  // Cleanup Ollama (stop managed instance)
  if (cleanupOllama) {
    await cleanupOllama();
  }
  stopGateway();
});

process.on("SIGINT", () => {
  console.log("[Electron] Received SIGINT, shutting down...");
  stopGateway();
  app.quit();
});

process.on("SIGTERM", () => {
  console.log("[Electron] Received SIGTERM, shutting down...");
  stopGateway();
  app.quit();
});
