/**
 * In-app platform browser (Social Login + Papr auth) using Electron WebContentsView.
 */

const { WebContentsView, shell } = require("electron");
const {
  getPlatformConfig,
  matchesSuccessUrl,
  cookieMatchesDomains,
} = require("./platformBrowserConfig.cjs");
const {
  platformNavigationUrlsMatch,
  shouldSkipPlatformLandingHop,
} = require("./platformBrowserUrl.cjs");

/** Rapid full-page navigations (LinkedIn feed redirect loop). */
const REDIRECT_LOOP_WINDOW_MS = 8000;
const REDIRECT_LOOP_THRESHOLD = 4;

/** @type {Map<string, { view: import('electron').WebContentsView, visible: boolean, bounds: { x: number, y: number, width: number, height: number } | null, platformId?: string, consoleLogs: Array<{ type: string, text: string, location: string, timestamp: string }>, networkLogs: Array<{ url: string, method: string, status: number, ok: boolean, resourceType: string, timestamp: string }>, webContentsId?: number, consoleListenerAttached?: boolean, urlListenerAttached?: boolean }>} */
const platformSessions = new Map();

/** @type {WeakSet<import('electron').Session>} */
const platformNetworkDispatchSessions = new WeakSet();

function registerPlatformNetworkDispatch(session) {
  if (platformNetworkDispatchSessions.has(session)) {
    return;
  }
  platformNetworkDispatchSessions.add(session);
  session.webRequest.onCompleted((details) => {
    for (const entry of platformSessions.values()) {
      if (entry.webContentsId !== details.webContentsId) {
        continue;
      }
      entry.networkLogs.push({
        url: details.url,
        method: details.method,
        status: details.statusCode,
        ok: details.statusCode >= 200 && details.statusCode < 400,
        resourceType: details.resourceType,
        timestamp: new Date().toISOString(),
      });
      if (entry.networkLogs.length > 500) {
        entry.networkLogs.shift();
      }
    }
  });
}

function attachPlatformDiagnostics(platformId, entry) {
  const webContents = entry.view.webContents;
  entry.platformId = platformId;
  entry.webContentsId = webContents.id;
  if (!Array.isArray(entry.consoleLogs)) {
    entry.consoleLogs = [];
  }
  if (!Array.isArray(entry.networkLogs)) {
    entry.networkLogs = [];
  }

  registerPlatformNetworkDispatch(webContents.session);

  if (!entry.consoleListenerAttached) {
    webContents.on("console-message", (_event, level, message, _line, sourceId) => {
      entry.consoleLogs.push({
        type: String(level),
        text: message,
        location: sourceId || "",
        timestamp: new Date().toISOString(),
      });
      if (entry.consoleLogs.length > 500) {
        entry.consoleLogs.shift();
      }
    });
    entry.consoleListenerAttached = true;
  }

  if (!entry.urlListenerAttached) {
    const notifyUrlChange = () => {
      const win = getMainWindow?.();
      if (!win || win.isDestroyed() || webContents.isDestroyed()) {
        return;
      }
      win.webContents.send("platform-browser:url-changed", {
        platformId,
        url: webContents.getURL(),
        title: webContents.getTitle(),
      });
    };

    /** @type {Array<{ url: string, at: number }>} */
    entry.recentNavigations = entry.recentNavigations ?? [];

    webContents.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame || typeof url !== "string") {
        return;
      }
      const now = Date.now();
      entry.recentNavigations = entry.recentNavigations.filter(
        (item) => now - item.at < REDIRECT_LOOP_WINDOW_MS,
      );
      entry.recentNavigations.push({ url, at: now });

      const feedLike = entry.recentNavigations.filter((item) =>
        /linkedin\.com\/feed/i.test(item.url),
      );
      if (feedLike.length < REDIRECT_LOOP_THRESHOLD) {
        return;
      }
      if (entry.redirectLoopPaused) {
        return;
      }
      entry.redirectLoopPaused = true;
      console.warn(
        `[PlatformBrowser] Redirect loop detected for ${platformId} — pausing navigation`,
      );
      try {
        webContents.stop();
      } catch {
        /* ignore */
      }
      const win = getMainWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send("platform-browser:redirect-loop", {
          platformId,
          url,
        });
      }
    });

    webContents.on("did-navigate", notifyUrlChange);
    webContents.on("did-navigate-in-page", notifyUrlChange);
    webContents.on("page-title-updated", notifyUrlChange);
    webContents.on("did-finish-load", notifyUrlChange);
    entry.urlListenerAttached = true;
  }
}

/** @type {(() => import('electron').BrowserWindow | null) | null} */
let getMainWindow = null;

function execJsWithTimeout(webContents, script, timeoutMs = 8000, label = "script") {
  return Promise.race([
    webContents.executeJavaScript(script, true),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

function partitionFor(platformId) {
  return `persist:papr-platform-${platformId}`;
}

function toElectronSameSite(raw, secure) {
  const normalized = String(raw ?? "lax").toLowerCase();
  if (normalized === "none" || normalized === "no_restriction") {
    return secure ? "no_restriction" : "lax";
  }
  if (normalized === "strict") {
    return "strict";
  }
  return "lax";
}

function cookieSetUrl(cookie) {
  const domain = String(cookie.domain ?? "").replace(/^\./, "");
  const path = typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/";
  const secure = cookie.secure !== false;
  return `${secure ? "https" : "http"}://${domain}${path.startsWith("/") ? path : `/${path}`}`;
}

function getSessionWebContents(platformId) {
  const entry = platformSessions.get(platformId);
  if (!entry || entry.view.webContents.isDestroyed()) {
    return null;
  }
  return entry.view.webContents;
}

function attachPlatformView(platformId, view) {
  const win = getMainWindow?.();
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.contentView.addChildView(view);
  } catch {
    /* already attached */
  }
}

function detachPlatformView(platformId) {
  const entry = platformSessions.get(platformId);
  const win = getMainWindow?.();
  if (!entry || !win || win.isDestroyed()) {
    return;
  }
  try {
    win.contentView.removeChildView(entry.view);
  } catch {
    /* ignore */
  }
}

function applyBounds(platformId) {
  const entry = platformSessions.get(platformId);
  const win = getMainWindow?.();
  if (!entry || !win || win.isDestroyed() || !entry.bounds) {
    return;
  }
  if (entry.visible) {
    attachPlatformView(platformId, entry.view);
    entry.view.setBounds(entry.bounds);
  } else {
    detachPlatformView(platformId);
  }
}

function isBlankPlatformUrl(url) {
  return !url || url === "about:blank" || url.startsWith("about:");
}

function loadInitialPlatformUrlIfNeeded(platformId, webContents) {
  if (!isBlankPlatformUrl(webContents.getURL())) {
    return;
  }
  const config = getPlatformConfig(platformId);
  const url = config?.homeUrl || config?.loginUrl;
  if (!url) {
    return;
  }
  void webContents.loadURL(url).catch((err) => {
    console.warn(
      `[PlatformBrowser] Failed to load initial URL for ${platformId}:`,
      err,
    );
  });
}

/** OAuth / same-site popups load in the embedded tab; other links open externally. */
const OAUTH_LOGIN_HOSTS = [
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "facebook.com",
  "www.facebook.com",
];

function hostMatchesCookieDomain(host, domain) {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  const bare = h.replace(/^www\./, "");
  return bare === normalized || bare.endsWith("." + normalized);
}

function shouldNavigatePopupInPlatformTab(url, platformId) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (OAUTH_LOGIN_HOSTS.includes(host)) {
      return true;
    }

    const config = getPlatformConfig(platformId);
    const domains = [
      ...(config?.cookieDomains ?? []),
      ...(config?.additionalDomains ?? []),
    ];
    for (const domain of domains) {
      if (hostMatchesCookieDomain(host, domain)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

function getOrCreateView(platformId) {
  let entry = platformSessions.get(platformId);
  if (entry && !entry.view.webContents.isDestroyed()) {
    attachPlatformDiagnostics(platformId, entry);
    return entry;
  }

  const view = new WebContentsView({
    webPreferences: {
      partition: partitionFor(platformId),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: platformId !== "papr-auth",
    },
  });

  if (platformId === "papr-auth") {
    view.webContents.setWindowOpenHandler(({ url }) => {
      void view.webContents.loadURL(url);
      return { action: "deny" };
    });
  } else {
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (shouldNavigatePopupInPlatformTab(url, platformId)) {
        void view.webContents.loadURL(url);
        return { action: "deny" };
      }
      shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
  }

  entry = {
    view,
    visible: false,
    bounds: null,
    consoleLogs: [],
    networkLogs: [],
    consoleListenerAttached: false,
    urlListenerAttached: false,
  };
  platformSessions.set(platformId, entry);
  attachPlatformDiagnostics(platformId, entry);
  return entry;
}

function notifyOpenTab(platformId) {
  const win = getMainWindow?.();
  if (!win || win.isDestroyed()) {
    return;
  }
  if (platformId === "papr-auth") {
    win.webContents.send("papr-auth-browser-open", {});
    return;
  }
  win.webContents.send("platform-browser:open-tab", { platformId });
}

async function waitForLoad(webContents, timeoutMs = 60_000) {
  if (webContents.isLoading()) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Navigation timed out")), timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      webContents.once("did-finish-load", finish);
      webContents.once("did-fail-load", (_event, _code, desc) => {
        clearTimeout(timer);
        reject(new Error(desc || "Navigation failed"));
      });
    });
  }
}

function resolvePlatformCdpUrl() {
  if (process.env.PAPR_PLATFORM_CDP_DISABLE === "1") {
    return null;
  }
  if (process.env.LINKEDIN_CHROME_CDP_URL) {
    return process.env.LINKEDIN_CHROME_CDP_URL;
  }
  if (process.env.PAPR_PLATFORM_CDP_URL) {
    return process.env.PAPR_PLATFORM_CDP_URL;
  }
  const port = process.env.PAPR_PLATFORM_CDP_PORT || "9222";
  return `http://127.0.0.1:${port}`;
}

/**
 * Prepare embedded platform WebContents for CDP attach (Python Playwright jobs).
 * Does not force-open the tab UI — only ensures the view + session exist and loads
 * home URL when blank (preserves user's current page when already browsing).
 */
async function handleEnsureCdp(payload) {
  const platformId = payload.platformId;
  if (typeof platformId !== "string") {
    return { success: false, error: "platformId is required" };
  }

  const config = getPlatformConfig(platformId);
  const entry = getOrCreateView(platformId);
  const webContents = entry.view.webContents;
  loadInitialPlatformUrlIfNeeded(platformId, webContents);

  const homeUrl = config?.homeUrl || config?.loginUrl;
  if (homeUrl && isBlankPlatformUrl(webContents.getURL())) {
    await webContents.loadURL(homeUrl);
    await waitForLoad(webContents);
  }

  const cdpUrl = resolvePlatformCdpUrl();
  if (!cdpUrl) {
    return {
      success: false,
      error:
        "Platform CDP is disabled (PAPR_PLATFORM_CDP_DISABLE=1). Remove it to allow Python jobs to connect_over_cdp.",
    };
  }

  return {
    success: true,
    data: {
      platformId,
      cdpUrl,
      webContentsId: webContents.id,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      partition: partitionFor(platformId),
    },
  };
}

async function handleEnsure(payload) {
  const platformId = payload.platformId;
  if (typeof platformId !== "string") {
    return { success: false, error: "platformId is required" };
  }

  const config = getPlatformConfig(platformId);
  getOrCreateView(platformId);
  notifyOpenTab(platformId);

  const url =
    typeof payload.url === "string" && payload.url.length > 0
      ? payload.url
      : config?.homeUrl || config?.loginUrl;

  if (!url) {
    return { success: false, error: `Unsupported platform: ${platformId}` };
  }

  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Failed to create platform browser view" };
  }

  const entry = platformSessions.get(platformId);
  if (entry) {
    entry.redirectLoopPaused = false;
    entry.recentNavigations = [];
  }

  const currentUrl = webContents.getURL();
  const destination = config?.homeUrl ?? url;
  if (
    shouldSkipPlatformLandingHop(platformId, currentUrl, destination) &&
    platformNavigationUrlsMatch(currentUrl, destination)
  ) {
    return {
      success: true,
      data: {
        platformId,
        url: currentUrl,
        title: webContents.getTitle(),
        skippedNavigation: true,
      },
    };
  }

  if (
    shouldSkipPlatformLandingHop(platformId, currentUrl, url) &&
    !platformNavigationUrlsMatch(currentUrl, url)
  ) {
    // Already authenticated — skip landing hop (e.g. linkedin.com/ before /feed/).
    return {
      success: true,
      data: {
        platformId,
        url: currentUrl,
        title: webContents.getTitle(),
        skippedNavigation: true,
      },
    };
  }

  if (!platformNavigationUrlsMatch(currentUrl, url)) {
    await webContents.loadURL(url);
    await waitForLoad(webContents);
  }

  return {
    success: true,
    data: {
      platformId,
      url: webContents.getURL(),
      title: webContents.getTitle(),
    },
  };
}

async function handleNavigate(payload) {
  const platformId = payload.platformId;
  const url = payload.url;
  if (typeof platformId !== "string" || typeof url !== "string") {
    return { success: false, error: "platformId and url are required" };
  }

  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Platform browser not initialized" };
  }

  const entry = platformSessions.get(platformId);
  if (entry?.redirectLoopPaused) {
    return {
      success: false,
      error:
        "LinkedIn session redirect loop detected. Disconnect and reconnect in Settings → Platform Connections, or log in again in this tab.",
    };
  }

  if (platformNavigationUrlsMatch(webContents.getURL(), url)) {
    return {
      success: true,
      data: {
        url: webContents.getURL(),
        title: webContents.getTitle(),
        skippedNavigation: true,
      },
    };
  }

  await webContents.loadURL(url);
  await waitForLoad(webContents);

  return {
    success: true,
    data: {
      url: webContents.getURL(),
      title: webContents.getTitle(),
    },
  };
}

async function handleSnapshot(payload) {
  const platformId = payload.platformId;
  const maxHtmlChars = Number(payload.maxHtmlChars) || 80_000;
  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Platform browser not initialized" };
  }

  const html = await execJsWithTimeout(
    webContents,
    "document.documentElement.outerHTML",
    15_000,
    "snapshot(html)",
  );

  return {
    success: true,
    data: {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      html: typeof html === "string" ? html.slice(0, maxHtmlChars) : "",
    },
  };
}

async function handleClick(payload) {
  const platformId = payload.platformId;
  const selector = payload.selector;
  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Platform browser not initialized" };
  }
  if (typeof selector !== "string") {
    return { success: false, error: "selector is required" };
  }

  await execJsWithTimeout(
    webContents,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
      el.click();
    })()`,
    10_000,
    "click",
  );

  return { success: true, data: { clicked: selector } };
}

async function handleExecute(payload) {
  const platformId = payload.platformId;
  const script = payload.script;
  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Platform browser not initialized" };
  }
  if (typeof script !== "string" || script.length === 0) {
    return { success: false, error: "script is required" };
  }

  const wrapped = `(async () => { ${script} })()`;
  const result = await execJsWithTimeout(webContents, wrapped, 15_000, "execute");
  return { success: true, data: { result } };
}

async function handleFill(payload) {
  const platformId = payload.platformId;
  const selector = payload.selector;
  const text = payload.text;
  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Platform browser not initialized" };
  }
  if (typeof selector !== "string" || typeof text !== "string") {
    return { success: false, error: "selector and text are required" };
  }

  await execJsWithTimeout(
    webContents,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
      el.focus();
      if ("value" in el) {
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })()`,
    10_000,
    "fill",
  );

  return { success: true, data: { selector, filled: true } };
}

async function handleGetState(payload) {
  const platformId = payload.platformId;
  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Platform browser not initialized" };
  }
  return {
    success: true,
    data: {
      url: webContents.getURL(),
      title: webContents.getTitle(),
    },
  };
}

async function handleExtractCookies(payload) {
  const platformId = payload.platformId;
  const webContents = getSessionWebContents(platformId);
  if (!webContents) {
    return { success: false, error: "Platform browser not initialized" };
  }

  const config = getPlatformConfig(platformId);
  const payloadDomains = Array.isArray(payload.cookieDomains)
    ? payload.cookieDomains.map(String)
    : [];
  const domains =
    payloadDomains.length > 0 ? payloadDomains : (config?.cookieDomains ?? []);

  const session = webContents.session;
  const cookies = await session.cookies.get({});
  const filtered = cookies.filter((cookie) => cookieMatchesDomains(cookie, domains));

  return {
    success: true,
    data: {
      cookies: filtered.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expirationDate ?? -1,
        httpOnly: cookie.httpOnly ?? false,
        secure: cookie.secure ?? true,
        sameSite: cookie.sameSite ?? "Lax",
      })),
    },
  };
}

async function handleInjectCookies(payload) {
  const platformId = payload.platformId;
  const cookies = payload.cookies;
  if (typeof platformId !== "string" || !Array.isArray(cookies)) {
    return { success: false, error: "platformId and cookies array are required" };
  }

  const entry = getOrCreateView(platformId);
  const session = entry.view.webContents.session;
  let injected = 0;

  for (const raw of cookies) {
    if (!raw || typeof raw.name !== "string" || typeof raw.value !== "string") {
      continue;
    }
    const secure = raw.secure !== false;
    await session.cookies.set({
      url: cookieSetUrl(raw),
      name: raw.name,
      value: raw.value,
      domain: typeof raw.domain === "string" ? raw.domain : undefined,
      path: typeof raw.path === "string" ? raw.path : "/",
      httpOnly: raw.httpOnly === true,
      secure,
      sameSite: toElectronSameSite(raw.sameSite, secure),
      ...(typeof raw.expires === "number" && raw.expires > 0
        ? { expirationDate: raw.expires }
        : {}),
    });
    injected += 1;
  }

  return { success: true, data: { injected } };
}

function handleHide(payload) {
  const platformId = payload.platformId;
  const entry = platformSessions.get(platformId);
  if (entry) {
    entry.visible = false;
    detachPlatformView(platformId);
  }
  return { success: true, data: { hidden: true } };
}

function handleShowTab(payload) {
  notifyOpenTab(payload.platformId);
  return { success: true, data: { opened: true } };
}

async function handleGetConsoleLogs(payload) {
  const platformId = payload.platformId;
  const entry = platformSessions.get(platformId);
  if (!entry) {
    return { success: false, error: "Platform browser not initialized" };
  }
  const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 200);
  const logs = entry.consoleLogs.slice(-limit);
  if (payload.clearAfterRead) {
    entry.consoleLogs.length = 0;
  }
  return { success: true, data: { count: logs.length, logs } };
}

async function handleGetNetworkLogs(payload) {
  const platformId = payload.platformId;
  const entry = platformSessions.get(platformId);
  if (!entry) {
    return { success: false, error: "Platform browser not initialized" };
  }
  const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 200);
  const logs = entry.networkLogs.slice(-limit);
  if (payload.clearAfterRead) {
    entry.networkLogs.length = 0;
  }
  return { success: true, data: { count: logs.length, logs } };
}

async function handlePlatformBrowserRequest(request) {
  const action = request.action;
  const payload = request.payload ?? {};

  switch (action) {
    case "ensure":
      return handleEnsure(payload);
    case "ensure_cdp":
      return handleEnsureCdp(payload);
    case "navigate":
      return handleNavigate(payload);
    case "snapshot":
      return handleSnapshot(payload);
    case "click":
      return handleClick(payload);
    case "fill":
      return handleFill(payload);
    case "execute":
      return handleExecute(payload);
    case "get_state":
      return handleGetState(payload);
    case "get_console_logs":
      return handleGetConsoleLogs(payload);
    case "get_network_logs":
      return handleGetNetworkLogs(payload);
    case "extract_cookies":
      return handleExtractCookies(payload);
    case "inject_cookies":
      return handleInjectCookies(payload);
    case "hide":
      return handleHide(payload);
    case "show_tab":
      return handleShowTab(payload);
    default:
      return { success: false, error: `Unknown platform browser action: ${action}` };
  }
}

function isRequestPlatformBrowserMessage(message) {
  return (
    message &&
    message.type === "REQUEST_PLATFORM_BROWSER" &&
    typeof message.requestId === "string" &&
    typeof message.request === "object" &&
    message.request !== null &&
    typeof message.request.action === "string"
  );
}

function registerPlatformBrowserIPC(ipcMain, getWindow) {
  getMainWindow = getWindow;

  ipcMain.handle("platform-browser:set-bounds", (_event, payload) => {
    const platformId = payload?.platformId;
    if (typeof platformId !== "string") {
      return { success: false, error: "platformId is required" };
    }

    const bounds = {
      x: Math.round(Number(payload.x) || 0),
      y: Math.round(Number(payload.y) || 0),
      width: Math.max(0, Math.round(Number(payload.width) || 0)),
      height: Math.max(0, Math.round(Number(payload.height) || 0)),
    };
    const visible = Boolean(payload.visible);

    let entry = platformSessions.get(platformId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      // Tab state persists across restarts but WebContentsView is in-memory only.
      // Recreate the view when the tab becomes visible; skip on hide/unmount cleanup.
      if (!visible || bounds.width === 0 || bounds.height === 0) {
        return { success: true };
      }
      entry = getOrCreateView(platformId);
      loadInitialPlatformUrlIfNeeded(platformId, entry.view.webContents);
    }

    entry.bounds = bounds;
    entry.visible = visible;
    applyBounds(platformId);
    return { success: true };
  });

  ipcMain.handle("platform-browser:open-login", async (_event, payload) => {
    const platformId = payload?.platformId;
    const config = getPlatformConfig(platformId);
    if (!config?.loginUrl) {
      return { success: false, error: `Unsupported platform: ${platformId}` };
    }
    const entry = getOrCreateView(platformId);
    notifyOpenTab(platformId);
    await entry.view.webContents.loadURL(config.loginUrl);
    await waitForLoad(entry.view.webContents);
    return {
      success: true,
      data: { platformId, url: entry.view.webContents.getURL() },
    };
  });

  ipcMain.handle("platform-browser:open-auth", async (_event, payload) => {
    const url = payload?.url;
    if (typeof url !== "string" || url.length === 0) {
      return { success: false, error: "url is required" };
    }
    const platformId = "papr-auth";
    const entry = getOrCreateView(platformId);
    notifyOpenTab(platformId);
    await entry.view.webContents.loadURL(url);
    await waitForLoad(entry.view.webContents);
    return {
      success: true,
      data: { platformId, url: entry.view.webContents.getURL() },
    };
  });

  ipcMain.handle("platform-browser:get-state", (_event, payload) => {
    const platformId = payload?.platformId;
    if (typeof platformId !== "string") {
      return { success: false, error: "platformId is required" };
    }
    const webContents = getSessionWebContents(platformId);
    if (!webContents) {
      return { success: true, data: { url: "", title: "" } };
    }
    return {
      success: true,
      data: {
        url: webContents.getURL(),
        title: webContents.getTitle(),
      },
    };
  });

  ipcMain.handle("platform-browser:reload", (_event, payload) => {
    const platformId = payload?.platformId;
    if (typeof platformId !== "string") {
      return { success: false, error: "platformId is required" };
    }
    const entry = platformSessions.get(platformId);
    if (entry) {
      entry.redirectLoopPaused = false;
      entry.recentNavigations = [];
    }
    const webContents = getSessionWebContents(platformId);
    if (!webContents) {
      return { success: false, error: "Platform browser not initialized" };
    }
    webContents.reload();
    return { success: true };
  });
}

module.exports = {
  registerPlatformBrowserIPC,
  handlePlatformBrowserRequest,
  isRequestPlatformBrowserMessage,
  getPlatformConfig,
  matchesSuccessUrl,
  openAuthBrowser: async (url) =>
    handleEnsure({ platformId: "papr-auth", url }),
};
