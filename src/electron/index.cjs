/**
 * Electron Shell
 *
 * Minimal Electron wrapper that loads the UI from the Gateway
 * CommonJS format - Electron's require() is more reliable than ESM
 */

const { app, BrowserWindow, Menu } = require("electron");
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
let initializePermissionsIPC;

async function loadESMModules() {
  // Import from compiled dist directory
  const storageModule = await import("../../dist/core/storage/index.js");
  CustomKeysStorage = storageModule.CustomKeysStorage;
  KeyPermissionsStorage = storageModule.KeyPermissionsStorage;
  SettingsStorage = storageModule.SettingsStorage;

  const customKeysIpcModule = await import("../../dist/electron/electron/ipc/customKeys.js");
  initializeCustomKeysIPC = customKeysIpcModule.initializeCustomKeysIPC;

  const permissionsIpcModule = await import("../../dist/electron/electron/ipc/permissions.js");
  initializePermissionsIPC = permissionsIpcModule.initializePermissionsIPC;
}

// Configuration
const UI_DEV_URL = process.env.UI_DEV_URL || "http://localhost:5173";
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

let mainWindow = null;
let gatewayProcess = null;

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
  });

  // Hide default menu
  Menu.setApplicationMenu(null);

  const uiUrl = IS_PRODUCTION
    ? `http://localhost:${GATEWAY_PORT}`
    : UI_DEV_URL;

  console.log(`[Electron] Loading UI from: ${uiUrl}`);
  
  // Add error handler for load failures
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[Electron] Failed to load UI: ${errorCode} - ${errorDescription}`);
    console.error(`[Electron] Attempted URL: ${uiUrl}`);
    console.error(`[Electron] Is Gateway running? Check port ${GATEWAY_PORT}`);
  });
  
  mainWindow.loadURL(uiUrl).catch(err => {
    console.error('[Electron] loadURL failed:', err);
  });

  // Always open DevTools to see console errors
  mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Launch Gateway as subprocess
function startGateway(customKeysStorage) {
  // Gateway is compiled to dist/gateway/ from project root
  const gatewayScript = path.join(__dirname, "../../dist/gateway/index.js");

  console.log(`[Electron] Starting Gateway...`);
  console.log(`[Electron] Gateway path: ${gatewayScript}`);
  console.log(`[Electron] Gateway port: ${GATEWAY_PORT}`);
  console.log(`[Electron] Working directory: ${process.cwd()}`);

  // Use Electron's embedded Node.js to ensure version consistency (Node v24)
  const electronNodePath = process.execPath; // Path to electron binary

  gatewayProcess = spawn(electronNodePath, [gatewayScript], {
    stdio: ["inherit", "inherit", "inherit", "ipc"], // Enable IPC
    env: {
      ...process.env,
      GATEWAY_PORT: String(GATEWAY_PORT),
      NODE_ENV: IS_PRODUCTION ? "production" : "development",
      ELECTRON_RUN_AS_NODE: "1", // Run Electron as Node.js
    },
  });

  // Set up IPC for Gateway communication
  gatewayProcess.on("message", async (msg) => {
    // Handle key resolution requests (existing)
    if (msg.type === "REQUEST_KEYS") {
      console.log("[Electron] Gateway requested keys:", msg.keys);

      const resolvedKeys = {};
      for (const keyName of msg.keys || []) {
        try {
          const value = await customKeysStorage.getKeyByName(keyName);
          if (value) {
            resolvedKeys[keyName] = value;
            console.log(`[Electron]   ✓ Resolved ${keyName}`);
          } else {
            console.log(`[Electron]   ✗ Key ${keyName} not found`);
          }
        } catch (error) {
          console.error(`[Electron]   ✗ Error resolving ${keyName}:`, error);
        }
      }

      gatewayProcess.send({
        type: "KEYS_RESPONSE",
        requestId: msg.requestId,
        keys: resolvedKeys,
      });
    }
    
    // Handle permission requests from Gateway (new)
    else if (msg.type === "REQUEST_PERMISSION") {
      console.log("[Electron] Gateway requested permission:", msg.request);

      try {
        // Forward to main window's IPC handler
        const { ipcMain } = require("electron");
        const response = await new Promise((resolve) => {
          // Use the permissions:request-key handler we set up
          ipcMain.emit("permissions:request-key-from-gateway", {
            requestId: msg.requestId,
            request: msg.request,
            resolve,
          });
        });

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

  // Start Gateway process
  startGateway(customKeysStorage);

  // Wait for Gateway to start (check if it's actually running)
  let attempts = 0;
  const maxAttempts = 20; // 10 seconds max
  
  const checkGateway = setInterval(() => {
    attempts++;
    
    // Try to connect to Gateway
    const http = require('http');
    const req = http.get(`http://localhost:${GATEWAY_PORT}/`, (res) => {
      console.log(`[Electron] Gateway is ready (status: ${res.statusCode})`);
      clearInterval(checkGateway);
      createMainWindow();
      
      // Initialize permissions IPC after window is created
      initializePermissionsIPC(keyPermissionsStorage, settingsStorage, mainWindow);
    });
    
    req.on('error', (err) => {
      if (attempts >= maxAttempts) {
        console.error(`[Electron] Gateway failed to start after ${maxAttempts} attempts`);
        clearInterval(checkGateway);
        // Try to create window anyway
        createMainWindow();
      } else {
        console.log(`[Electron] Waiting for Gateway... (${attempts}/${maxAttempts})`);
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

app.on("before-quit", () => {
  console.log("[Electron] App quitting...");
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
