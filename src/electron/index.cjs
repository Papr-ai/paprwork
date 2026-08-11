/**
 * Electron Shell
 *
 * Minimal Electron wrapper that loads the UI from the Gateway
 * CommonJS format - Electron's require() is more reliable than ESM
 */

// Load environment variables from .env.local FIRST (before any other imports)
require("dotenv").config({ path: require("path").join(__dirname, "../../.env.local") });

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
let initializeChatAttachmentsIPC;
let TelemetryClientClass;
let isTelemetrySendingEnabledFn;
let telemetryClientInstance = null;
let initializePaprLoginIPC;
let ensureActiveNamespaceApiKey;
let resolveActivePaprApiKey;
let setGatewayRestartAfterWorkspaceSwitch;
let cleanupPaprLogin;
let handlePaprAuthCallback;
let trackPaprLoginDeepLinkQueued;
let trackPaprLoginDeepLinkFlushStarted;
let syncProfileToGatewaySettings;
let migrateOrgVaultIsolation;
let migrateIntegrationKeysToSharedDefault;


/**
 * Check Python installation on Windows and notify user if missing
 */
async function checkPythonInstallation() {
  try {
    // Try to run python --version
    execSync('python --version', { timeout: 5000, stdio: 'pipe' });
    console.log('[Electron] Python is installed');
  } catch (error) {
    // Python not found - show notification
    console.warn('[Electron] Python not found, user will be notified when needed');
    
    // We don't auto-install silently on startup anymore
    // Instead, we show a helpful message when Python jobs are first created/run
    // This avoids scary installation prompts on first launch
  }
}

/**
 * Dynamic import with retry for transient macOS EINTR errors.
 * Coffee-shop / high-load machines often interrupt fs reads during module load;
 * a single retry almost always succeeds.
 */
async function importWithRetry(specifier, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await import(specifier);
    } catch (error) {
      lastError = error;
      const code = error && error.code;
      const message = error instanceof Error ? error.message : String(error);
      const isEintr =
        code === "EINTR" ||
        message.includes("EINTR") ||
        message.includes("interrupted system call");
      if (!isEintr || i === attempts) {
        throw error;
      }
      console.warn(
        `[Electron] Transient ${code || "EINTR"} loading ${specifier} (attempt ${i}/${attempts}), retrying…`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50 * i));
    }
  }
  throw lastError;
}

async function loadESMModules() {
  // Import from compiled dist directory
  const storageModule = await importWithRetry("../../dist/core/storage/index.js");
  CustomKeysStorage = storageModule.CustomKeysStorage;
  KeyPermissionsStorage = storageModule.KeyPermissionsStorage;
  SettingsStorage = storageModule.SettingsStorage;
  migrateOrgVaultIsolation = storageModule.migrateOrgVaultIsolation;
  migrateIntegrationKeysToSharedDefault =
    storageModule.migrateIntegrationKeysToSharedDefault;

  const customKeysIpcModule =
    await importWithRetry("../../dist/electron/electron/ipc/customKeys.js");
  initializeCustomKeysIPC = customKeysIpcModule.initializeCustomKeysIPC;
  setGatewayProcess = customKeysIpcModule.setGatewayProcess;

  const permissionsIpcModule =
    await importWithRetry("../../dist/electron/electron/ipc/permissions.js");
  initializePermissionsIPC = permissionsIpcModule.initializePermissionsIPC;
  requestPermissionFromGateway =
    permissionsIpcModule.requestPermissionFromGateway;

  // Import OAuth IPC module
  const oauthIpcModule =
    await importWithRetry("../../dist/electron/electron/ipc/oauth.js");
  initializeOAuthIPC = oauthIpcModule.initializeOAuthIPC;
  cleanupOAuthServers = oauthIpcModule.cleanupOAuthServers;

  // Import Papr Login IPC module
  const paprLoginIpcModule =
    await importWithRetry("../../dist/electron/electron/ipc/paprLogin.js");
  initializePaprLoginIPC = paprLoginIpcModule.initializePaprLoginIPC;
  ensureActiveNamespaceApiKey = paprLoginIpcModule.ensureActiveNamespaceApiKey;
  resolveActivePaprApiKey = paprLoginIpcModule.resolveActivePaprApiKey;
  cleanupPaprLogin = paprLoginIpcModule.cleanupPaprLogin;
  handlePaprAuthCallback = paprLoginIpcModule.handlePaprAuthCallback;
  trackPaprLoginDeepLinkQueued = paprLoginIpcModule.trackPaprLoginDeepLinkQueued;
  trackPaprLoginDeepLinkFlushStarted = paprLoginIpcModule.trackPaprLoginDeepLinkFlushStarted;
  syncProfileToGatewaySettings = paprLoginIpcModule.syncProfileToGatewaySettings;

  const paprWorkspaceIpcModule =
    await importWithRetry("../../dist/electron/electron/ipc/paprWorkspace.js");
  setGatewayRestartAfterWorkspaceSwitch =
    paprWorkspaceIpcModule.setGatewayRestartAfterWorkspaceSwitch;

  // Import Ollama IPC module
  const ollamaIpcModule =
    await importWithRetry("../../dist/electron/electron/electron/ipc/ollama.js");
  initializeOllamaIPC = ollamaIpcModule.initializeOllamaIPC;

  // Import Ollama Manager for cleanup
  const ollamaManagerModule =
    await importWithRetry("../../dist/electron/electron/electron/services/OllamaManager.js");
  const ollamaManager = ollamaManagerModule.getOllamaManager();
  cleanupOllama = () => ollamaManager.cleanup();

  const telemetryIpcModule = await importWithRetry(
    "../../dist/electron/electron/ipc/telemetry.js"
  );
  initializeTelemetryIPC = telemetryIpcModule.initializeTelemetryIPC;

  const chatAttachmentsIpcModule = await importWithRetry(
    "../../dist/electron/electron/ipc/chatAttachments.js"
  );
  initializeChatAttachmentsIPC = chatAttachmentsIpcModule.initializeChatAttachmentsIPC;

  const telemetryClientModule = await importWithRetry(
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
let isQuitting = false;
let isInstallingUpdate = false;
let gatewayProcess = null;
const webviewSessions = new Map();
let defaultWebviewId = null;
let webviewCounter = 0;
const webviewNetworkDispatchSessions = new WeakSet();

// Single shared webRequest.onCompleted listener per Electron session.
// Electron replaces (not stacks) webRequest listeners, so per-window
// registration silently broke network logging for earlier sessions —
// which is why module/script requests appeared to be "missing" from logs.
function registerWebviewNetworkDispatch(session) {
  if (webviewNetworkDispatchSessions.has(session)) return;
  webviewNetworkDispatchSessions.add(session);
  session.webRequest.onCompleted((details) => {
    for (const entry of webviewSessions.values()) {
      if (entry.webContentsId !== details.webContentsId) continue;
      entry.networkLogs.push({
        url: details.url,
        statusCode: details.statusCode,
        method: details.method,
        resourceType: details.resourceType,
        timestamp: new Date().toISOString(),
      });
      if (entry.networkLogs.length > 500) {
        entry.networkLogs.shift();
      }
    }
  });
}

// executeJavaScript can hang indefinitely when the renderer is busy or
// frozen — which made snapshot/execute tools time out with no diagnosis.
// Bound every call and surface a labeled "renderer unresponsive" error.
function execJsWithTimeout(win, script, timeoutMs = 8000, label = "script") {
  return Promise.race([
    win.webContents.executeJavaScript(script),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Renderer unresponsive: ${label} did not complete within ${Math.round(timeoutMs / 1000)}s. ` +
                "The page may be frozen during startup (heavy synchronous work or a hung module load).",
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);
}

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
    // so the network dispatch never touches a dead webContents object.
    const webContentsId = win.webContents.id;
    entry.webContentsId = webContentsId;
    // NOTE: Electron only supports ONE webRequest.onCompleted listener per
    // session. Registering per-window listeners silently replaced earlier
    // ones (and closing any window cleared logging for all). Use a single
    // shared listener that dispatches to every live session instead.
    registerWebviewNetworkDispatch(session);

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
      // The shared network dispatch listener stays registered; it simply
      // finds no matching live session for this webContentsId anymore.
      webviewSessions.delete(id);
      if (defaultWebviewId === id) {
        defaultWebviewId = null;
      }
    });

    // Non-blocking launch: never let a slow/hung page load exceed the IPC
    // bridge timeout. Wait up to 10s for load; on timeout return the session
    // anyway with status "launching" so callers can poll with page_wait_for.
    const LAUNCH_WAIT_MS = 10000;
    let loadStatus = "loaded";
    let loadError = null;
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise((_, rejectRace) =>
          setTimeout(
            () => rejectRace(new Error("launch-wait-timeout")),
            LAUNCH_WAIT_MS,
          ),
        ),
      ]);
    } catch (err) {
      if (err && err.message === "launch-wait-timeout") {
        loadStatus = "launching";
      } else {
        loadStatus = "load-error";
        loadError = err && err.message ? err.message : String(err);
      }
    }
    return {
      success: true,
      data: {
        webviewId: id,
        url,
        title: win.webContents.getTitle(),
        status: loadStatus,
        ...(loadError ? { loadError } : {}),
        ...(loadStatus !== "loaded"
          ? {
              hint:
                "Session was created but the page has not finished loading. " +
                "Use page_wait_for({ target: 'mini_app' }) then webview_snapshot.",
            }
          : {}),
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
    const html = await execJsWithTimeout(
      win,
      "document.documentElement.outerHTML",
      8000,
      "snapshot(html)",
    );
    const text = await execJsWithTimeout(
      win,
      "document.body ? document.body.innerText : ''",
      8000,
      "snapshot(text)",
    );
    const visualState = await execJsWithTimeout(win, `(() => {
      function isVisible(el) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      const brokenHidden = Array.from(document.querySelectorAll('.hidden')).filter(isVisible);
      const overlays = Array.from(document.querySelectorAll('#modal-overlay, .modal-overlay')).filter(isVisible);
      const main = document.getElementById('content') || document.querySelector('main');
      const warnings = [];
      if (brokenHidden.length > 0) {
        warnings.push(brokenHidden.length + ' element(s) have class "hidden" but are still visible — add .hidden { display: none } to CSS');
      }
      if (overlays.length > 0 && main && !main.innerText.trim()) {
        warnings.push('Modal overlay is visible but main content is empty — UI may look blank/blurred to the user');
      }
      const boot = window.__paprBoot
        ? {
            moduleRan: !!window.__paprBoot.moduleRan,
            errors: (window.__paprBoot.errors || []).slice(0, 5),
            phases: window.__paprBoot.phases || {},
          }
        : null;
      if (boot && !boot.moduleRan) {
        warnings.push('Boot watchdog: entry script module has not executed — app code is not running');
      }
      if (boot && boot.errors.length > 0) {
        warnings.push('Boot watchdog errors: ' + boot.errors.join(' | '));
      }
      return {
        brokenHiddenCount: brokenHidden.length,
        visibleOverlayCount: overlays.length,
        mainContentEmpty: main ? !main.innerText.trim() : null,
        warnings,
        boot,
        userWouldSeeBlankUi: brokenHidden.length > 0 || (overlays.length > 0 && main && !main.innerText.trim()),
      };
    })()`, 8000, "snapshot(visualState)");
    return {
      success: true,
      data: {
        webviewId: id,
        url: win.webContents.getURL(),
        title: win.webContents.getTitle(),
        html: typeof html === "string" ? html.slice(0, maxHtmlChars) : "",
        text: typeof text === "string" ? text.slice(0, maxTextChars) : "",
        visualState,
      },
    };
  }

  if (action === "execute") {
    const script = payload.script;
    if (typeof script !== "string" || script.length === 0) {
      return { success: false, error: "script is required for execute" };
    }
    const result = await execJsWithTimeout(win, script, 15000, "execute");
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

  if (action === "wait_for") {
    const rawTimeout = Number(payload.timeout);
    const timeoutMs =
      Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(rawTimeout, 30000)
        : 30000;
    const pollMs = 250;
    const deadline = Date.now() + timeoutMs;

    if (payload.time !== undefined && payload.time !== null) {
      const seconds = Math.min(
        Math.max(Number(payload.time) || 1, 0.1),
        30,
      );
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return {
        success: true,
        data: { webviewId: id, waited: seconds, unit: "seconds" },
      };
    }

    const hasText =
      typeof payload.text === "string" && payload.text.length > 0;
    const hasTextGone =
      typeof payload.textGone === "string" && payload.textGone.length > 0;
    const hasSelector =
      typeof payload.selector === "string" && payload.selector.length > 0;

    if (!hasText && !hasTextGone && !hasSelector) {
      return {
        success: false,
        error: "wait_for requires text, textGone, selector, or time",
      };
    }

    while (Date.now() < deadline) {
      if (hasText) {
        const found = await win.webContents.executeJavaScript(
          `(function(){var t=${JSON.stringify(payload.text)};return !!(document.body&&document.body.innerText&&document.body.innerText.includes(t));})()`,
        );
        if (found) {
          return {
            success: true,
            data: { webviewId: id, found: payload.text },
          };
        }
      } else if (hasTextGone) {
        const gone = await win.webContents.executeJavaScript(
          `(function(){var t=${JSON.stringify(payload.textGone)};return !(document.body&&document.body.innerText&&document.body.innerText.includes(t));})()`,
        );
        if (gone) {
          return {
            success: true,
            data: { webviewId: id, gone: payload.textGone },
          };
        }
      } else if (hasSelector) {
        const found = await win.webContents.executeJavaScript(
          `(function(){return !!document.querySelector(${JSON.stringify(payload.selector)});})()`,
        );
        if (found) {
          return {
            success: true,
            data: { webviewId: id, found: payload.selector },
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      success: false,
      error: `Preview wait timed out after ${timeoutMs}ms`,
      data: { webviewId: id, url: win.webContents.getURL() },
    };
  }

  return { success: false, error: `Unknown webview action: ${action}` };
}

// Minimal window setup - just load the UI
async function waitForGatewayFullyReady(
  maxAttempts = 120,
  intervalMs = 500,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ready = await new Promise((resolve) => {
      const req = http.get(`http://localhost:${GATEWAY_PORT}/health`, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body).status === "ok");
          } catch {
            resolve(false);
          }
        });
      });
      req.on("error", () => resolve(false));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ready) {
      console.log(`[Electron] Gateway fully ready (attempt ${attempt})`);
      return true;
    }
    if (attempt === 1 || attempt % 10 === 0) {
      console.log(
        `[Electron] Waiting for Gateway routes... (${attempt}/${maxAttempts})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.warn("[Electron] Gateway not fully ready — loading UI anyway");
  return false;
}

async function createMainWindow() {
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
    // Enable window resizing
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
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
      }] : []),
      ...(isEditable ? [
        {
          label: 'Cut',
          role: 'cut',
          enabled: !!selectionText
        },
        {
          label: 'Paste',
          role: 'paste',
        }
      ] : []),
      ...(isEditable && selectionText ? [
        { type: 'separator' },
        {
          label: 'Select All',
          role: 'selectAll',
        }
      ] : [])
    ]);
    
    menu.popup({ window: mainWindow });
  });


  const uiUrl = IS_PRODUCTION ? `http://localhost:${GATEWAY_PORT}` : UI_DEV_URL;

  const loadStartTime = Date.now();
  if (IS_PRODUCTION) {
    await waitForGatewayFullyReady();
  }
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

  // Handle window close button
  // Windows: Close button should quit the app (standard behavior)
  // macOS: Close button should hide the window (app stays in dock)
  mainWindow.on("close", (event) => {
    if (process.platform === "darwin") {
      // During Cmd+Q / app.quit(), allow destroy() to proceed — don't intercept
      if (isQuitting) {
        return;
      }
      // macOS: Hide window but keep app running (standard macOS behavior)
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
    }
    // Windows/Linux: Let the window close normally, which triggers app.quit()
  });

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

function readActiveWorkspacePointerOrgId() {
  return readActiveWorkspacePointer()?.organizationId;
}

function readActiveWorkspacePointer() {
  try {
    const fs = require("fs");
    const pathMod = require("path");
    const osMod = require("os");
    const pointerPath = pathMod.join(
      osMod.homedir(),
      "Papr",
      ".active-workspace.json",
    );
    if (!fs.existsSync(pointerPath)) {
      return undefined;
    }
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf-8"));
    if (
      typeof pointer?.organizationId !== "string" ||
      typeof pointer?.namespaceId !== "string"
    ) {
      return undefined;
    }
    return pointer;
  } catch {
    return undefined;
  }
}

function paprApiKeyMatchesNamespaceBound(apiKey, organizationId, namespaceId) {
  const trimmed = apiKey.trim();
  const prefix = `sk-org-${organizationId}-namespace-${namespaceId}-`;
  if (trimmed.startsWith(prefix)) {
    return true;
  }
  const match = trimmed.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) {
    // Legacy keys omit embedded namespace — trust vault slot / GraphQL binding.
    return true;
  }
  return match[2] === namespaceId;
}

function paprApiKeyMatchesActiveWorkspace(apiKey) {
  const trimmed = apiKey.trim();
  const match = trimmed.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) {
    return false;
  }

  const orgId = process.env.PAPR_ORG_ID?.trim();
  const namespaceId = process.env.PAPR_NAMESPACE_ID?.trim();
  if (orgId && namespaceId) {
    return paprApiKeyMatchesNamespaceBound(apiKey, orgId, namespaceId);
  }

  const pointer = readActiveWorkspacePointer();
  if (!pointer) {
    return true;
  }

  return paprApiKeyMatchesNamespaceBound(
    apiKey,
    pointer.organizationId,
    pointer.namespaceId,
  );
}

// Pure logic functions — imported from separate file for unit testing
const {
  calculateBackoff,
  isCircuitBroken,
  pruneTimestamps,
  getNotificationType,
  shouldKillProcess,
  parseHealthResponse,
  shouldKillUnhealthyGateway,
  parseGatewaySyncBusyState,
  isGatewaySyncBusyGraceActive,
  isValidTransition,
} = require("./supervisor-logic.cjs");

class GatewayProcessSupervisor {
  constructor(options) {
    this.gatewayScript = options.gatewayScript;
    this.gatewayArgs = options.gatewayArgs ?? [];
    this.electronNodePath = options.electronNodePath;
    this.gatewayEnv = options.gatewayEnv;
    this.readActiveWorkspaceEnv = options.readActiveWorkspaceEnv ?? null;
    this.port = options.port;
    this.customKeysStorage = options.customKeysStorage;
    this.settingsStorage = options.settingsStorage ?? null;
    this.getActiveOrganizationId = options.getActiveOrganizationId;

    // State
    this.state = "stopped";
    this.process = null;
    this.restartCount = 0;
    this.restartTimestamps = [];
    this.healthCheckTimer = null;
    this.healthFailures = 0;
    this.hasEverBeenHealthy = false;
    this.gatewayReadyNotified = false;
    this.backoffTimer = null;
    this.isStopping = false;

    // Config
    this.BACKOFF_BASE_MS = 500;
    this.BACKOFF_MAX_MS = 30000;
    this.CIRCUIT_BREAKER_MAX = 5;
    this.CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;
    this.HEALTH_INTERVAL_MS = 10000;
    this.HEALTH_FAILURE_THRESHOLD = 8;
    this.HEALTH_REQUEST_TIMEOUT_MS = 30000;
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
    this.gatewayReadyNotified = false;
    this._transitionTo("starting");
    this._sendStatusToRenderer("starting", "Gateway is starting...");
    this._killOrphans();
    this._spawnProcess();
    await this._waitForReady();
    if (this.isStopping) return;
    this._transitionTo("running");
    this._startHealthCheck();
  }

  async stop() {
    this.isStopping = true;
    this._stopHealthCheck();
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.process && !this.process.killed) {
      const pid = this.process.pid;
      console.log("[Supervisor] Stopping Gateway process (PID: %s)...", pid);
      try {
        // Send SIGTERM for graceful shutdown
        this.process.kill("SIGTERM");
        
        // Wait for process to exit gracefully (up to 3 seconds)
        await new Promise((resolve) => {
          let attempts = 0;
          const checkInterval = setInterval(() => {
            attempts++;
            if (!this.process || this.process.killed) {
              clearInterval(checkInterval);
              console.log("[Supervisor] Gateway stopped gracefully");
              resolve();
            } else if (attempts >= 30) { // 30 * 100ms = 3 seconds
              clearInterval(checkInterval);
              console.log("[Supervisor] Gateway didn't stop gracefully, force killing...");
              if (this.process && !this.process.killed) {
                this.process.kill("SIGKILL");
              }
              resolve();
            }
          }, 100);
        });
      } catch (error) {
        console.warn("[Supervisor] Error stopping Gateway:", error.message);
      }
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
          const output = execSync(`lsof -ti:${this.port}`, { encoding: "utf8" }).trim();
          if (output) {
            // Split by newline to handle multiple PIDs
            const pids = output.split('\n').filter(p => p.trim());
            console.log(`[Supervisor] Found ${pids.length} orphaned process(es) on port ${this.port}: ${pids.join(', ')}`);
            
            // Kill each PID individually
            for (const pid of pids) {
              try {
                execSync(`kill -9 ${pid.trim()}`);
                console.log(`[Supervisor] Killed orphaned process ${pid}`);
              } catch (killErr) {
                console.warn(`[Supervisor] Failed to kill PID ${pid}:`, killErr.message);
              }
            }
            
            execSync("sleep 0.5");
            console.log("[Supervisor] Orphaned processes cleanup complete");
          }
        } catch (e) {
          // No process on port — good
        }
      }
    } catch (error) {
      console.warn("[Supervisor] Cleanup warning:", error.message);
    }
  }

  _resolveSpawnEnv() {
    const workspaceEnv =
      typeof this.readActiveWorkspaceEnv === "function"
        ? this.readActiveWorkspaceEnv()
        : {};
    return { ...this.gatewayEnv, ...workspaceEnv };
  }

  _spawnProcess() {
    console.log(`[Supervisor] Starting Gateway on port ${this.port}...`);
    console.log(
      `[Supervisor] Gateway spawn: ${this.electronNodePath} ${this.gatewayScript} ${this.gatewayArgs.join(" ")}`.trim(),
    );

    const spawnEnv = this._resolveSpawnEnv();

    this.process = spawn(
      this.electronNodePath,
      [this.gatewayScript, ...this.gatewayArgs],
      {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: spawnEnv,
      },
    );

    this.hasEverBeenHealthy = false;
    this.healthFailures = 0;
    this.gatewayReadyNotified = false;
    this._sendStatusToRenderer("starting", "Gateway is starting...");

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
    const settings = this.settingsStorage;

    proc.on("message", async (msg) => {
      // Guard: if process was replaced during async handling, skip
      if (proc !== this.process) return;

      if (isRequestKeysMessage(msg)) {
        console.log("[Electron] Gateway requested keys:", msg.keys);

        const resolvedKeys = {};
        for (const keyName of msg.keys || []) {
          try {
            if (keyName === "PAPR_API_KEY" && resolveActivePaprApiKey) {
              let value = await resolveActivePaprApiKey(storage);
              if (
                !value &&
                ensureActiveNamespaceApiKey &&
                settings
              ) {
                console.log(
                  "[Electron] PAPR_API_KEY missing for active workspace — syncing namespace key…",
                );
                value = await ensureActiveNamespaceApiKey(storage, settings);
              }
              if (value) {
                const pointer = readActiveWorkspacePointer();
                const boundOk =
                  !pointer ||
                  paprApiKeyMatchesNamespaceBound(
                    value,
                    pointer.organizationId,
                    pointer.namespaceId,
                  );
                if (boundOk) {
                  resolvedKeys[keyName] = value;
                  console.log(`[Electron]   ✓ Resolved ${keyName}`);
                } else {
                  console.warn(
                    "[Electron]   ✗ PAPR_API_KEY resolved with wrong namespace scope — omitting",
                  );
                }
              } else {
                const envFallback = process.env[keyName];
                if (
                  envFallback &&
                  paprApiKeyMatchesActiveWorkspace(envFallback)
                ) {
                  resolvedKeys[keyName] = envFallback;
                  console.log(`[Electron]   ✓ Resolved ${keyName} from env fallback`);
                } else if (envFallback) {
                  console.warn(
                    "[Electron]   ✗ Ignoring PAPR_API_KEY env fallback — wrong namespace for active workspace",
                  );
                } else {
                  console.log(`[Electron]   ✗ Key ${keyName} not found`);
                }
              }
              continue;
            }

            const value = await storage.getKeyByName(keyName);
            if (value !== null) {
              if (
                keyName === "PAPR_API_KEY" &&
                !paprApiKeyMatchesActiveWorkspace(value)
              ) {
                console.warn(
                  "[Electron]   ✗ PAPR_API_KEY in keychain is for a different namespace — omitting until sync completes",
                );
              } else {
                resolvedKeys[keyName] = value;
                console.log(`[Electron]   ✓ Resolved ${keyName}`);
              }
            } else {
              const envFallback = process.env[keyName];
              if (
                envFallback &&
                (keyName !== "PAPR_API_KEY" ||
                  paprApiKeyMatchesActiveWorkspace(envFallback))
              ) {
                resolvedKeys[keyName] = envFallback;
                console.log(`[Electron]   ✓ Resolved ${keyName} from env fallback`);
              } else if (envFallback && keyName === "PAPR_API_KEY") {
                console.warn(
                  "[Electron]   ✗ Ignoring PAPR_API_KEY env fallback — wrong namespace for active workspace",
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
          const organizationId = this.getActiveOrganizationId?.()?.trim();
          if (organizationId && storage?.ensureOrganizationVault) {
            await storage.ensureOrganizationVault(organizationId);
          }
          const keys = await storage.listKeys();
          //console.log(`[Electron] Loaded ${keys.length} keys from storage:`, keys.map(k => k.name));
          if (proc === this.process) {
            proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, keys });
            //console.log(`[Electron] Sent CUSTOM_KEYS_RESPONSE with ${keys.length} keys`);
          }
        } catch (error) {
          console.error("[Electron] custom-keys:list error:", error);
          if (proc === this.process) proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
        }
      } else if (msg.type === "CUSTOM_KEYS_GET_BY_NAME") {
        try {
          const organizationId = this.getActiveOrganizationId?.()?.trim();
          if (organizationId && storage?.ensureOrganizationVault) {
            await storage.ensureOrganizationVault(organizationId);
          }
          const value = await storage.getKeyByName(msg.name);
          const found = value ? "found" : "not found";
          const preview = value ? `${value.substring(0, 10)}...` : "null";
          //console.log(`[Electron] Key "${msg.name}" ${found} (preview: ${preview})`);
          if (proc === this.process) {
            proc.send({ type: "CUSTOM_KEYS_RESPONSE", requestId: msg.requestId, value });
            //console.log(`[Electron] Sent CUSTOM_KEYS_RESPONSE with value ${found}`);
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
    this.gatewayReadyNotified = false;
    this._transitionTo("starting");
    this._sendStatusToRenderer("restarting", "Gateway is restarting...");
    this._killOrphans();
    this._spawnProcess();
    await this._waitForReady();
    if (this.isStopping) return;
    this._transitionTo("running");
    this.restartCount = 0; // Reset on successful start
    this._startHealthCheck();

    // Notify UI that gateway is fully ready (legacy "running" kept for compat)
    this._sendStatusToRenderer("ready", "Gateway is ready");
    this._sendStatusToRenderer("running", "Gateway reconnected");
  }

  /** Restart gateway after workspace pointer change (Electron-side recovery). */
  async restartForWorkspaceSwitch() {
    if (this.isStopping) {
      return;
    }
    console.log("[Supervisor] Restarting gateway for workspace switch recovery...");
    this._stopHealthCheck();
    if (this.process && !this.process.killed) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Process may already be exiting
      }
      await new Promise((resolve) => {
        let attempts = 0;
        const timer = setInterval(() => {
          attempts++;
          if (!this.process || this.process.killed || attempts >= 30) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
      this.process = null;
      gatewayProcess = null;
    }
    await this._performRestart();
  }

  _readSyncBusyGraceHealth() {
    try {
      const fs = require("fs");
      const env =
        typeof this.readActiveWorkspaceEnv === "function"
          ? this.readActiveWorkspaceEnv()
          : null;
      const paprHome = env?.PAPR_HOME;
      if (!paprHome) {
        return null;
      }
      const busyPath = path.join(
        paprHome,
        "data",
        ".gateway-sync-busy.json",
      );
      if (!fs.existsSync(busyPath)) {
        return null;
      }
      const state = parseGatewaySyncBusyState(
        fs.readFileSync(busyPath, "utf8"),
      );
      if (!isGatewaySyncBusyGraceActive(state)) {
        return null;
      }
      return { alive: true, ready: false, syncBusy: true };
    } catch {
      return null;
    }
  }

  _startHealthCheck() {
    this.healthFailures = 0;
    this._stopHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      const req = http.get(`http://localhost:${this.port}/health`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          const health = parseHealthResponse(body);
          this._onHealthCheckResult(health);
        });
      });
      req.on("error", () => {
        const busyGrace = this._readSyncBusyGraceHealth();
        this._onHealthCheckResult(
          busyGrace ?? { alive: false, ready: false },
        );
      });
      req.setTimeout(this.HEALTH_REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        const busyGrace = this._readSyncBusyGraceHealth();
        this._onHealthCheckResult(
          busyGrace ?? { alive: false, ready: false },
        );
      });
    }, this.HEALTH_INTERVAL_MS);
  }

  _stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  _onHealthCheckResult(health) {
    if (health.ready) {
      this.hasEverBeenHealthy = true;
      if (!this.gatewayReadyNotified) {
        this.gatewayReadyNotified = true;
        this._sendStatusToRenderer("ready", "Gateway is ready");
      }
    }

    const result = shouldKillUnhealthyGateway(
      this.healthFailures,
      health,
      this.hasEverBeenHealthy,
      this.HEALTH_FAILURE_THRESHOLD,
    );
    this.healthFailures = result.newCount;

    if (result.shouldKill) {
      console.error(`[Supervisor] Health check failed ${this.HEALTH_FAILURE_THRESHOLD} times, killing gateway`);
      this._stopHealthCheck();
      if (this.process) {
        this.process.kill("SIGKILL");
        // _onProcessExit will handle restart scheduling
      }
    } else if (health.syncBusy) {
      console.log(
        "[Supervisor] Gateway busy uploading (health slow/unreachable — grace active)",
      );
    } else if (!health.alive && this.hasEverBeenHealthy) {
      console.warn(`[Supervisor] Health check failed (${this.healthFailures}/${this.HEALTH_FAILURE_THRESHOLD})`);
    } else if (health.alive && !health.ready) {
      console.log("[Supervisor] Gateway still starting (services loading)...");
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

  _waitForReady(maxAttempts = 240, intervalMs = 500) {
    return new Promise((resolve) => {
      let attempts = 0;
      let resolved = false;
      let startingNotified = false;

      const check = setInterval(() => {
        if (this.isStopping) {
          clearInterval(check);
          resolve();
          return;
        }
        attempts++;
        const req = http.get(`http://localhost:${this.port}/health`, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            if (resolved) return;
            const health = parseHealthResponse(body);
            if (health.alive && !health.ready && !startingNotified) {
              startingNotified = true;
              this._sendStatusToRenderer("starting", "Gateway is starting...");
            }
            if (health.ready) {
              resolved = true;
              clearInterval(check);
              this.gatewayReadyNotified = true;
              this._sendStatusToRenderer("ready", "Gateway is ready");
              console.log("[Supervisor] Gateway is ready (health probe)");
              resolve();
            } else if (attempts >= maxAttempts) {
              resolved = true;
              clearInterval(check);
              console.error(
                `[Supervisor] Gateway failed to become ready after ${maxAttempts} attempts (alive=${health.alive}, ready=${health.ready})`,
              );
              if (health.alive) {
                this._sendStatusToRenderer(
                  "starting",
                  "Gateway is still starting (slow load)...",
                );
              }
              resolve();
            } else if (health.alive && attempts % 10 === 0) {
              console.log(
                `[Supervisor] Waiting for Gateway ready... (${attempts}/${maxAttempts})`,
              );
            } else if (!health.alive) {
              console.log(`[Supervisor] Waiting for Gateway... (${attempts}/${maxAttempts})`);
            }
          });
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
        req.setTimeout(5000, () => {
          req.destroy();
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

const UPDATE_RECOVERY_HINT =
  "If the app won't open after updating: quit Papr Work, delete " +
  "~/Library/Caches/com.paprwork.v2.ShipIt, remove /Applications/Papr Work.app, " +
  "then reinstall the latest arm64 .pkg from GitHub Releases.";

function formatUpdateError(rawMessage) {
  const message =
    typeof rawMessage === "string" ? rawMessage : String(rawMessage ?? "Unknown error");
  const lower = message.toLowerCase();

  if (lower.includes("read-only volume") || lower.includes("readonly")) {
    return {
      error:
        "Update cannot install while Papr Work is on a read-only volume. " +
        "Install to /Applications using the .pkg installer.",
      recoveryHint: UPDATE_RECOVERY_HINT,
    };
  }

  if (
    lower.includes("shipit") ||
    lower.includes("signature") ||
    lower.includes("codesign") ||
    lower.includes("seckey") ||
    lower.includes("corrupt") ||
    lower.includes("damaged")
  ) {
    return {
      error: `Update installation failed: ${message}`,
      recoveryHint: UPDATE_RECOVERY_HINT,
    };
  }

  if (
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("net::") ||
    lower.includes("econnrefused") ||
    lower.includes("timed out")
  ) {
    return {
      error: `Could not reach the update server: ${message}`,
      recoveryHint: "Check your internet connection and try again.",
    };
  }

  if (lower.includes("not packaged")) {
    return {
      error: message,
      recoveryHint: "Auto-updates only work in packaged builds from GitHub Releases.",
    };
  }

  return { error: message };
}

/**
 * Synchronously kill Gateway before ShipIt swaps the app bundle.
 * Graceful async cleanup races ShipIt; skipping cleanup leaves native module
 * file locks inside the .app and the update never installs or relaunches.
 */
function fastKillChildProcessesForUpdate() {
  if (!supervisor) {
    return;
  }

  supervisor.isStopping = true;
  supervisor._stopHealthCheck();
  if (supervisor.backoffTimer) {
    clearTimeout(supervisor.backoffTimer);
    supervisor.backoffTimer = null;
  }

  const proc = supervisor.getProcess();
  if (proc && !proc.killed) {
    console.log("[AutoUpdater] SIGKILL Gateway before update (PID:", proc.pid, ")");
    try {
      proc.kill("SIGKILL");
    } catch (error) {
      console.warn("[AutoUpdater] Gateway SIGKILL failed:", error.message);
    }
  }

  supervisor.process = null;
  gatewayProcess = null;
  if (setGatewayProcess) {
    setGatewayProcess(null);
  }

  supervisor._killOrphans();
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  // Only install when the user explicitly clicks "Restart to update".
  // autoInstallOnAppQuit races with before-quit cleanup and can corrupt ShipIt installs.
  autoUpdater.autoInstallOnAppQuit = false;
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
    const formatted = formatUpdateError(err.message);
    sendUpdateStatus("error", formatted);
  });

  // IPC: renderer can request "install now" (quit & install)
  ipcMain.on("updater:install", () => {
    console.log("[AutoUpdater] User requested install, quitting and installing...");
    isInstallingUpdate = true;
    isQuitting = true;

    fastKillChildProcessesForUpdate();

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }

    // Brief delay so the OS releases native module file handles before ShipIt runs.
    setTimeout(() => {
      autoUpdater.quitAndInstall(false, true);
    }, 300);
  });

  // IPC: renderer can manually trigger a check
  ipcMain.on("updater:check", () => {
    console.log("[AutoUpdater] Manual check requested");
    
    // Check if running in development/unpackaged mode
    if (!app.isPackaged) {
      console.log("[AutoUpdater] Skipping check - app is not packaged");
      sendUpdateStatus("error", formatUpdateError(
        "Updates are only available in packaged builds. Running from source doesn't support auto-updates."
      ));
      return;
    }
    
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[AutoUpdater] Manual check failed:", err.message);
      sendUpdateStatus("error", formatUpdateError(err.message));
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
      sendUpdateStatus("error", formatUpdateError(err.message));
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
      // Send message to renderer to open a new chat tab or embedded app agent
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chat:open', {
          message: options?.message || '',
          model: options?.model || null,
          provider: options?.provider || null,
          mode: options?.mode || (options?.subAgentId ? 'app-agent' : 'main'),
          appId: options?.appId || null,
          subAgentId: options?.subAgentId || null,
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

/** Deep links received before auth IPC is ready (macOS open-url can fire pre-ready). */
const pendingDeepLinks = [];
/** True after Gateway + main window are ready — auth callbacks need both. */
let authDeepLinksReady = false;

async function flushPendingDeepLinks() {
  if (
    !authDeepLinksReady ||
    !handlePaprAuthCallback ||
    !customKeysStorage ||
    !settingsStorage
  ) {
    return;
  }
  while (pendingDeepLinks.length > 0) {
    const pendingCount = pendingDeepLinks.length;
    if (trackPaprLoginDeepLinkFlushStarted) {
      trackPaprLoginDeepLinkFlushStarted(pendingCount);
    }
    console.log("[Electron] Flushing pending deep links:", pendingCount);
    const url = pendingDeepLinks.shift();
    try {
      await handlePaprAuthCallback(url, customKeysStorage, settingsStorage);
    } catch (err) {
      console.error("[Electron] Deep link handler failed:", err);
    }
  }
}

function queueDeepLink(url) {
  if (typeof url !== "string" || !url.startsWith("papr://")) {
    return;
  }
  console.log("[Electron] Queued deep link:", url.split("?")[0], {
    authDeepLinksReady,
    pending: pendingDeepLinks.length + 1,
  });
  pendingDeepLinks.push(url);
  if (trackPaprLoginDeepLinkQueued) {
    trackPaprLoginDeepLinkQueued({
      deepLinkReady: authDeepLinksReady,
      pendingCount: pendingDeepLinks.length,
    });
  }
  void flushPendingDeepLinks();
}

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
    if (url) {
      console.log('[Electron] Second instance opened with deep link:', url);
      queueDeepLink(url);
    }
  });

  // macOS: capture papr:// callbacks before app.whenReady (Electron best practice)
  app.on('open-url', (event, url) => {
    event.preventDefault();
    queueDeepLink(url);
  });
}

app.whenReady().then(async () => {
  const appStartTime = Date.now();
  console.log("[Electron] ===========================================");
  console.log("[Electron] App starting fresh - PID:", process.pid);
  console.log("[Electron] Start time:", new Date(appStartTime).toISOString());
  console.log("[Electron] ===========================================");

  // Register custom URL protocol for papr:// deep links
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      const registered = app.setAsDefaultProtocolClient('papr', process.execPath, [path.resolve(process.argv[1])]);
      console.log('[Electron] Protocol handler registered (dev mode):', registered);
    }
  } else {
    const registered = app.setAsDefaultProtocolClient('papr');
    console.log('[Electron] Protocol handler registered (production):', registered);
  }
  
  console.log('[Electron] isDefaultProtocolClient for papr://:', app.isDefaultProtocolClient('papr'));

  // Load ESM modules first
  await loadESMModules();

  // Initialize storage and IPC (use outer scope variables for second-instance handler)
  customKeysStorage = new CustomKeysStorage();
  keyPermissionsStorage = new KeyPermissionsStorage();
  settingsStorage = new SettingsStorage(undefined, {
    defaultTelemetryEnabled: app.isPackaged,
  });

  await customKeysStorage.initialize();
  const paprProfileForKeys = settingsStorage.getPaprProfile();
  if (migrateOrgVaultIsolation) {
    const migrationResult = await migrateOrgVaultIsolation(
      path.join(app.getPath("userData"), "data"),
      paprProfileForKeys?.organizationId,
    );
    if (migrationResult.ran) {
      console.log(
        "[Electron] Org vault isolation migration complete:",
        migrationResult,
      );
    }
  }
  if (migrateIntegrationKeysToSharedDefault) {
    const sharedMigration = await migrateIntegrationKeysToSharedDefault(
      path.join(app.getPath("userData"), "data"),
    );
    if (sharedMigration.ran) {
      console.log(
        "[Electron] Integration keys shared-default migration complete:",
        sharedMigration,
      );
      await customKeysStorage.initialize();
    }
  }
  if (paprProfileForKeys?.organizationId) {
    await customKeysStorage.setActiveOrganization(paprProfileForKeys.organizationId);
  }
  // Note: KeyPermissionsStorage and SettingsStorage auto-initialize via electron-store

  if (initializeTelemetryIPC) {
    initializeTelemetryIPC(settingsStorage);
  }

  if (initializeChatAttachmentsIPC) {
    initializeChatAttachmentsIPC();
  }

  ipcMain.handle("app:get-version", () => app.getVersion());

  // Backfill gateway settings with Papr user id before telemetry + gateway spawn
  const paprProfile = settingsStorage.getPaprProfile();
  if (paprProfile?.userId && paprProfile.email && syncProfileToGatewaySettings) {
    await syncProfileToGatewaySettings(
      paprProfile.email,
      paprProfile.userId,
      paprProfile.displayName,
      paprProfile.profileImage,
      paprProfile.activeNamespaceName,
    );
  }

  if (TelemetryClientClass && isTelemetrySendingEnabledFn) {
    telemetryClientInstance = new TelemetryClientClass({
      getEffectiveEnabled: () =>
        isTelemetrySendingEnabledFn(() =>
          settingsStorage.getTelemetryEnabled(),
        ),
      getAnonymousInstallId: () =>
        settingsStorage.getOrCreateTelemetryInstallId(),
      getPaprUserId: () => settingsStorage.getPaprProfile()?.userId ?? "",
      getIsPackaged: () => app.isPackaged,
      appVersion: app.getVersion(),
    });
    telemetryClientInstance.trackFireAndForget("paprwork_app_started");
  }

  initializeCustomKeysIPC(customKeysStorage, {
    getActiveOrganizationId: () =>
      readActiveWorkspacePointerOrgId() ||
      settingsStorage.getPaprProfile()?.organizationId,
  });

  // Initialize OAuth IPC handlers (pass customKeysStorage for syncing)
  await initializeOAuthIPC(customKeysStorage, {
    trackOAuthEvent: (eventName, properties) => {
      if (telemetryClientInstance) {
        telemetryClientInstance.trackFireAndForget(eventName, properties);
      }
    },
  });

  // Initialize Papr Login IPC handlers
  initializePaprLoginIPC(customKeysStorage, settingsStorage, {
    trackLoginEvent: (eventName, properties) => {
      if (telemetryClientInstance) {
        telemetryClientInstance.trackFireAndForget(eventName, properties);
      }
    },
  });

  if (ensureActiveNamespaceApiKey) {
    try {
      await ensureActiveNamespaceApiKey(customKeysStorage, settingsStorage);
    } catch (error) {
      console.warn(
        "[Electron] Startup namespace API key sync failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Check Python installation on Windows (for non-technical users)
  if (process.platform === 'win32') {
    checkPythonInstallation().catch(err => {
      console.error('[Electron] Python check failed:', err);
    });
  }

  const readActiveWorkspaceEnv = () => {
    try {
      const fs = require("fs");
      const pathMod = require("path");
      const osMod = require("os");
      const pointerPath = pathMod.join(osMod.homedir(), "Papr", ".active-workspace.json");
      if (!fs.existsSync(pointerPath)) {
        return {};
      }
      const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf-8"));
      if (!pointer?.paprHome || !pointer?.userDataPath) {
        return {};
      }
      return {
        PAPR_HOME: pointer.paprHome,
        PAPR_USER_DATA: pointer.userDataPath,
        PAPR_ORG_ID: pointer.organizationId,
        PAPR_NAMESPACE_ID: pointer.namespaceId,
      };
    } catch {
      return {};
    }
  };

  const readWorkspaceSettingsPath = () => {
    const fs = require("fs");
    const pathMod = require("path");
    const osMod = require("os");
    const workspaceEnv = readActiveWorkspaceEnv();
    if (workspaceEnv.PAPR_HOME) {
      return pathMod.join(workspaceEnv.PAPR_HOME, "data", "settings.json");
    }
    return pathMod.join(osMod.homedir(), "Papr", "data", "settings.json");
  };

  const activeWorkspaceEnv = readActiveWorkspaceEnv();
  const workspaceSettingsPath = readWorkspaceSettingsPath();

  // Build gateway environment (telemetry flags align with main-process resolution)
  const gatewayTelemetryOn =
    isTelemetrySendingEnabledFn != null
      ? isTelemetrySendingEnabledFn(() =>
          settingsStorage.getTelemetryEnabled(),
        )
      : settingsStorage.getTelemetryEnabled();
  const gatewayEnv = {
    ...process.env,
    ...activeWorkspaceEnv,
    GATEWAY_PORT: String(GATEWAY_PORT),
    NODE_ENV: IS_PRODUCTION ? "production" : "development",
    ELECTRON_RUN_AS_NODE: "1",
    CLOUD_SYNC_ENABLED: (() => {
      try {
        if (require("fs").existsSync(workspaceSettingsPath)) {
          const data = JSON.parse(require("fs").readFileSync(workspaceSettingsPath, "utf-8"));
          if (data?.preferences?.cloudSyncEnabled === false) return "false";
        }
        return "true";
      } catch {
        return "true";
      }
    })(),
    CLOUD_AUTO_PUBLISH_ENABLED: (() => {
      try {
        if (require("fs").existsSync(workspaceSettingsPath)) {
          const data = JSON.parse(require("fs").readFileSync(workspaceSettingsPath, "utf-8"));
          if (data?.preferences?.cloudAutoPublishEnabled === false) return "false";
        }
        return "true";
      } catch {
        return "true";
      }
    })(),
    PAPRWORK_TELEMETRY_ENABLED: gatewayTelemetryOn ? "true" : "false",
    PAPRWORK_TELEMETRY_ANONYMOUS_ID:
      settingsStorage.getOrCreateTelemetryInstallId(),
    PAPRWORK_TELEMETRY_PAPR_USER_ID:
      settingsStorage.getPaprProfile()?.userId ?? "",
    PAPRWORK_APP_VERSION: app.getVersion(),
    PAPRWORK_IS_PACKAGED: app.isPackaged ? "true" : "false",
  };
  if (
    gatewayEnv.PAPR_API_KEY &&
    !paprApiKeyMatchesActiveWorkspace(gatewayEnv.PAPR_API_KEY)
  ) {
    console.warn(
      "[Electron] Stripping stale PAPR_API_KEY from gateway env — wrong namespace for active workspace",
    );
    delete gatewayEnv.PAPR_API_KEY;
  }
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
  const gatewayRoot = path.join(__dirname, "../..");
  const isDevGateway = process.env.NODE_ENV === "development";
  let gatewayScript;
  let gatewayArgs = [];

  // Always spawn dist/gateway directly so the child keeps Electron IPC.
  // tsx watch wraps the gateway in a subprocess that breaks process.send ↔ main.
  // npm run dev already runs build:gateway before electron:dev.
  gatewayScript = path.join(gatewayRoot, "dist/gateway/index.js");
  if (isDevGateway) {
    console.log("[Electron] Dev mode: Gateway via dist/gateway/index.js (IPC-safe)");
  }

  supervisor = new GatewayProcessSupervisor({
    gatewayScript,
    gatewayArgs,
    electronNodePath: process.execPath,
    gatewayEnv,
    readActiveWorkspaceEnv,
    port: GATEWAY_PORT,
    customKeysStorage,
    settingsStorage,
    getActiveOrganizationId: () =>
      readActiveWorkspacePointerOrgId() ||
      settingsStorage.getPaprProfile()?.organizationId,
  });

  if (setGatewayRestartAfterWorkspaceSwitch) {
    setGatewayRestartAfterWorkspaceSwitch(() => supervisor.restartForWorkspaceSwitch());
  }

  await supervisor.start();
  await createMainWindow();
  authDeepLinksReady = true;

  // Process auth deep links after Gateway + window are ready (callback needs both)
  const coldStartUrl = process.argv.find((arg) => arg.startsWith("papr://"));
  if (coldStartUrl) {
    queueDeepLink(coldStartUrl);
  }
  await flushPendingDeepLinks();

  setupAutoUpdater();

  // Initialize permissions IPC after window is created
  initializePermissionsIPC(keyPermissionsStorage, settingsStorage, mainWindow);

  // Initialize Ollama IPC handlers
  if (initializeOllamaIPC) {
    initializeOllamaIPC(mainWindow);
  }

  // Initialize system:invoke handler for mini-app system integration
  initializeSystemInvokeHandler(mainWindow);

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
}).catch((error) => {
  // Without this, EINTR / module-load failures become UnhandledPromiseRejectionWarning
  // and leave Electron half-started with no Gateway (blank UI / disconnected).
  console.error("[Electron] Fatal startup failure:", error);
  dialog.showErrorBox(
    "Papr Work failed to start",
    error instanceof Error ? error.message : String(error),
  );
  app.quit();
});

app.on("window-all-closed", () => {
  // Windows/Linux: Quit when all windows closed (standard behavior)
  // macOS: Keep app running (standard macOS behavior - app in dock)
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  // macOS: Re-create window when dock icon clicked and no windows open
  if (mainWindow === null) {
    await createMainWindow();
  } else if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
});

app.on("before-quit", async (event) => {
  // ShipIt needs an immediate quit — async cleanup races the bundle swap.
  if (isInstallingUpdate) {
    console.log("[Electron] Installing update — fast quit (skipping async cleanup)");
    isQuitting = true;
    fastKillChildProcessesForUpdate();
    return;
  }

  if (isQuitting) {
    console.log("[Electron] Already quitting, allowing quit to proceed");
    // Close all windows to ensure app actually quits
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    return; // Don't prevent - let it quit
  }
  
  // First time through - prevent quit and do cleanup
  event.preventDefault();
  isQuitting = true;
  console.log("[Electron] App is quitting - starting cleanup...");
  
  try {
    // Tell renderer to stop trying to reconnect
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log("[Electron] Notifying renderer of shutdown...");
      mainWindow.webContents.send('app:shutting-down');
    }
    
    if (telemetryClientInstance) {
      telemetryClientInstance.trackFireAndForget("paprwork_app_quit");
    }
    
    // Cleanup OAuth servers before stopping gateway
    if (cleanupOAuthServers) {
      console.log("[Electron] Cleaning up OAuth servers...");
      cleanupOAuthServers();
    }
    
    // Cleanup Papr login callback server
    if (cleanupPaprLogin) {
      console.log("[Electron] Cleaning up Papr login server...");
      cleanupPaprLogin();
    }
    
    // Cleanup Ollama (stop managed instance)
    if (cleanupOllama) {
      console.log("[Electron] Cleaning up Ollama...");
      await cleanupOllama();
    }
    
    // Stop Gateway supervisor (AWAIT to ensure it completes)
    if (supervisor) {
      console.log("[Electron] Stopping Gateway supervisor...");
      await supervisor.stop();
    }
    
    console.log("[Electron] Cleanup complete, destroying windows and quitting");
    
    // Destroy all windows before quitting (important on macOS)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      mainWindow = null;
    }
    
    // Now call app.quit() to trigger quit again (this time isQuitting=true so it proceeds)
    app.quit();
  } catch (error) {
    console.error("[Electron] Error during cleanup:", error);
    // Destroy window and quit anyway after error
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      mainWindow = null;
    }
    app.quit();
  }
});

app.on("will-quit", (event) => {
  console.log("[Electron] App will quit - final cleanup");

  if (isInstallingUpdate) {
    console.log("[Electron] Installing update — final Gateway kill for ShipIt");
    fastKillChildProcessesForUpdate();
    return;
  }
  
  // Force stop Gateway if somehow still running
  if (supervisor && supervisor.getProcess() && !supervisor.getProcess().killed) {
    console.log("[Electron] Force stopping Gateway on will-quit");
    try {
      supervisor.getProcess().kill("SIGKILL");
    } catch (error) {
      console.warn("[Electron] Error force-stopping Gateway:", error.message);
    }
  }
});

process.on("SIGINT", () => {
  if (isQuitting) return;
  console.log("[Electron] Received SIGINT, shutting down...");
  isQuitting = true;
  if (supervisor) supervisor.stop();
  // Give supervisor time to stop, then quit
  setTimeout(() => app.quit(), 500);
});

process.on("SIGTERM", () => {
  if (isQuitting) return;
  console.log("[Electron] Received SIGTERM, shutting down...");
  isQuitting = true;
  if (supervisor) supervisor.stop();
  // Give supervisor time to stop, then quit
  setTimeout(() => app.quit(), 500);
});
