/**
 * Platform Session Service
 *
 * Manages browser profiles, cookie extraction, and session storage for social platforms.
 *
 * Connection flow (desktop with Google Chrome installed):
 * 1. Import cookies from Chrome if the user is already logged in there
 * 2. Launch Papr-managed real Chrome window for login (passkeys/OAuth work)
 * 3. Poll for login completion and persist cookies to keychain
 * 4. Fall back to embedded Papr tab or Playwright when Chrome is unavailable
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { isGoogleChromeInstalled } from "./platformChromeEnv.js";
import {
  applyRealChromeStealthScripts,
  buildRealChromePersistentLaunchOptions,
} from "./platformRealChromeLaunch.js";
import {
  isPlatformBrowserBridgeAvailable,
  requestPlatformBrowser,
} from "../../utils/platformBrowserBridge.js";
import type { Browser, BrowserContext, Cookie } from "playwright";
import { getPaprDataDir, getPaprRoot } from "../../../core/utils/paprRoot.js";
import { getCustomKeysService } from "../CustomKeysService.js";
import {
  type PlatformConfig,
  type PlatformId,
  getPlatformConfig,
  getAllPlatformIds,
  getPlatformKeyName,
} from "./platformRegistry.js";
import {
  type ChromePuppeteerCookie,
  buildPlaywrightCookiesFromKeychainValues,
  chromePuppeteerToPlaywright,
  getPlaywrightCookieDomain,
  hasRequiredPlaywrightCookies,
  repairPlaywrightCookieDomains,
} from "./platformCookieUtils.js";
import { syncEmbeddedCookiesToKeychain } from "./platformEmbeddedBrowser.js";
import {
  isLinkedInSessionAliveFromBrowserUrl,
  sanitizeLinkedInProbeErrorForDisplay,
} from "./linkedinSessionValidation.js";
import { isAuthenticatedPlatformUrl, isLoggedOutPlatformUrl } from "./platformSessionUrl.js";
import {
  allowsEmbeddedPlatformSession,
  allowsPersonalChromeCookieImport,
} from "./platformConnectPolicy.js";

const CHROME_COOKIE_POLL_MS = 10_000; // 10s — each read can trigger a macOS keychain prompt
const CHROME_COOKIE_CACHE_MS = 20_000;

// Track if we've already tried installing Playwright
let playwrightInstallAttempted = false;

/**
 * Check if an error indicates Playwright package or browser is missing
 */
function isPlaywrightMissingError(errorMessage: string): boolean {
  return (
    errorMessage.includes("Cannot find package") ||
    errorMessage.includes("Cannot find module") ||
    errorMessage.includes("Executable doesn't exist") ||
    errorMessage.includes("browserType.launch") ||
    errorMessage.includes("not found") ||
    errorMessage.includes("PLAYWRIGHT") ||
    errorMessage.includes("ENOENT")
  );
}

/**
 * Load Playwright with auto-installation if browser not found
 */
async function loadPlaywright(): Promise<typeof import("playwright")> {
  try {
    const pw = await import("playwright");
    // Quick check if chromium is available by checking if executable exists
    const executablePath = pw.chromium.executablePath();
    // If executablePath returns empty or the file doesn't exist, we need to install
    if (!executablePath) {
      throw new Error("Chromium executable not found");
    }
    return pw;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check if it's a Playwright-related error we can auto-fix
    if (!playwrightInstallAttempted && isPlaywrightMissingError(errorMessage)) {
      console.log("[PlatformSessionService] Playwright not found, installing Chromium...");
      console.log("[PlatformSessionService] Error was:", errorMessage);
      playwrightInstallAttempted = true;

      try {
        // Install Chromium browser (this also installs playwright-core if needed)
        execSync("npx playwright install chromium", {
          stdio: "inherit",
          timeout: 5 * 60 * 1000, // 5 minute timeout for download
        });
        console.log("[PlatformSessionService] Chromium installed successfully");

        // Retry import
        return await import("playwright");
      } catch (installError) {
        console.error("[PlatformSessionService] Failed to install Playwright:", installError);
        throw new Error(
          "Playwright browser not installed. Please run: npx playwright install chromium"
        );
      }
    }

    throw error;
  }
}

export type PlatformStatus =
  | "connected"
  | "disconnected"
  | "expired"
  | "needs_reauth"
  | "connecting";

export interface PlatformSessionState {
  platformId: PlatformId;
  status: PlatformStatus;
  connectedAt?: string;
  lastRefreshedAt?: string;
  expiresAt?: string;
  error?: string;
}

interface PlatformSessionStore {
  sessions: Record<string, PlatformSessionState>;
  version: number;
}

const STORE_VERSION = 1;
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to log in
const REFRESH_TIMEOUT_MS = 60 * 1000; // 60 seconds for headless refresh (some sites are slow)
const NAVIGATION_TIMEOUT_MS = 60 * 1000; // 60 seconds for page navigation (social sites are slow)
const POLL_INTERVAL_MS = 1000; // Check URL every second during connect
const LINKEDIN_LIVE_VALIDATE_TTL_MS = 60 * 1000;
/** Skip aggressive LinkedIn probes right after a successful connect (avoids false logouts). */
const CONNECT_VALIDATION_GRACE_MS = 3 * 60 * 1000;

/**
 * Platform Session Service - Singleton
 */
export class PlatformSessionService {
  private initialized = false;
  private store: PlatformSessionStore = { sessions: {}, version: STORE_VERSION };
  private readonly storePath: string;
  private readonly browserProfilesDir: string;
  private activeBrowser: Browser | null = null;
  private activeContext: BrowserContext | null = null;
  private connectingPlatform: PlatformId | null = null;
  private cookiePollTimers = new Map<PlatformId, ReturnType<typeof setInterval>>();
  private cookiePollStartedAt = new Map<PlatformId, number>();
  private chromeCookieCache: {
    platformId: PlatformId;
    cookies: Map<string, string>;
    fetchedAt: number;
  } | null = null;
  private linkedInLiveValidationCache: {
    validatedAt: number;
    status: PlatformSessionState;
  } | null = null;

  constructor() {
    this.storePath = join(getPaprDataDir(), "platform-sessions.json");
    this.browserProfilesDir = join(getPaprRoot(), "browser-profiles");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const { refreshCustomPlatformConfigCache } = await import("./platformRegistry.js");
    await refreshCustomPlatformConfigCache();

    // Ensure directories exist
    await fs.mkdir(this.browserProfilesDir, { recursive: true });

    // Load existing state
    await this.loadStore();

    console.log("[PlatformSessionService] Initialized");
  }

  private async loadStore(): Promise<void> {
    try {
      const data = await fs.readFile(this.storePath, "utf-8");
      const parsed = JSON.parse(data) as PlatformSessionStore;
      if (parsed.version === STORE_VERSION) {
        this.store = parsed;
      }
    } catch {
      // File doesn't exist or is invalid - use defaults
    }
  }

  private async saveStore(): Promise<void> {
    await fs.writeFile(this.storePath, JSON.stringify(this.store, null, 2));
  }

  private getProfilePath(platformId: PlatformId): string {
    return join(this.browserProfilesDir, platformId);
  }

  /**
   * Get status for a single platform
   */
  async getStatus(platformId: PlatformId): Promise<PlatformSessionState> {
    if (!this.initialized) await this.initialize();

    const config = getPlatformConfig(platformId);
    if (!config) {
      return {
        platformId,
        status: "disconnected",
        error: `Unknown platform: ${platformId}`,
      };
    }

    // Check if we're currently connecting
    if (this.connectingPlatform === platformId) {
      return {
        platformId,
        status: "connecting",
      };
    }

    const stored = this.store.sessions[platformId];
    
    // Always verify cookies exist - they might have been restored after a restart
    const hasAllCookies = await this.verifyPlatformCookies(platformId, config);

    if (!hasAllCookies) {
      // Cookies not found - ensure status is disconnected
      if (stored && stored.status !== "disconnected") {
        this.store.sessions[platformId] = {
          ...stored,
          status: "disconnected",
          error: "Session cookies not found in keychain",
        };
        await this.saveStore();
      }
      return {
        platformId,
        status: "disconnected",
        error: stored?.error,
      };
    }

    // Cookies exist! If status was disconnected, restore to connected
    if (!stored || stored.status === "disconnected") {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + config.sessionDurationDays * 24 * 60 * 60 * 1000);
      this.store.sessions[platformId] = {
        platformId,
        status: "connected",
        connectedAt: stored?.connectedAt || now.toISOString(),
        lastRefreshedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await this.saveStore();
      console.log(`[PlatformSessionService] Restored ${platformId} connection - cookies found in keychain`);
      return this.store.sessions[platformId];
    }

    // Check expiration
    if (stored.expiresAt && new Date(stored.expiresAt) < new Date()) {
      return {
        ...stored,
        status: "expired",
      };
    }

    return stored;
  }

  /**
   * For LinkedIn: validate session when status looks connected.
   * Uses Papr-managed Chrome only when installed — never syncs from the embedded tab.
   */
  async getStatusWithLiveValidation(platformId: PlatformId): Promise<PlatformSessionState> {
    const status = await this.getStatus(platformId);
    if (platformId !== "linkedin") {
      return status;
    }

    const config = getPlatformConfig(platformId);
    if (!config) {
      return status;
    }

    if (status.status === "needs_reauth" || status.status === "expired") {
      if (allowsEmbeddedPlatformSession(platformId)) {
        const recovered = await this.tryRecoverEmbeddedLogin(platformId, config);
        if (recovered) {
          return recovered;
        }
      }
      if (status.error) {
        const sanitized = sanitizeLinkedInProbeErrorForDisplay(status.error);
        if (sanitized !== status.error) {
          return { ...status, error: sanitized };
        }
      }
      return status;
    }

    if (status.status !== "connected") {
      return status;
    }

    const now = Date.now();
    if (status.connectedAt) {
      const connectedMs = now - new Date(status.connectedAt).getTime();
      if (connectedMs < CONNECT_VALIDATION_GRACE_MS) {
        return status;
      }
    }

    if (
      this.linkedInLiveValidationCache &&
      now - this.linkedInLiveValidationCache.validatedAt < LINKEDIN_LIVE_VALIDATE_TTL_MS
    ) {
      return this.linkedInLiveValidationCache.status;
    }

    if (isPlatformBrowserBridgeAvailable() && allowsEmbeddedPlatformSession(platformId)) {
      await syncEmbeddedCookiesToKeychain(platformId);
      const embeddedLoggedIn = await this.isEmbeddedPlatformLoggedIn(platformId, config);
      if (embeddedLoggedIn) {
        this.linkedInLiveValidationCache = { validatedAt: now, status };
        return status;
      }
    }

    const { getRealChromeSessionUrl } = await import("./platformAgentBrowser.js");
    const chromeUrl = getRealChromeSessionUrl(platformId);
    if (chromeUrl) {
      if (isLinkedInSessionAliveFromBrowserUrl(chromeUrl, config)) {
        this.linkedInLiveValidationCache = { validatedAt: now, status };
        return status;
      }
      if (isLoggedOutPlatformUrl(chromeUrl)) {
        const updated = await this.markNeedsReauth(
          platformId,
          "redirected to login in Papr Chrome",
        );
        this.linkedInLiveValidationCache = { validatedAt: now, status: updated };
        return updated;
      }
    }

    // No logout signal from the real browser — keep stored status (never replay cookies over HTTP).
    this.linkedInLiveValidationCache = { validatedAt: now, status };
    return status;
  }

  private async isEmbeddedPlatformLoggedIn(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<boolean> {
    const stateResponse = await requestPlatformBrowser({
      action: "get_state",
      payload: { platformId },
    });
    if (!stateResponse.success || !stateResponse.data) {
      return false;
    }
    const url = String((stateResponse.data as { url?: string }).url ?? "");
    return config.successUrlPattern.test(url);
  }

  private resetConnectAttempt(platformId: PlatformId): void {
    if (this.connectingPlatform === platformId) {
      this.connectingPlatform = null;
    }
    this.stopChromeCookiePolling(platformId);
    this.clearLinkedInLiveValidationCache();
  }

  private async tryRecoverEmbeddedLogin(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<PlatformSessionState | null> {
    if (!allowsEmbeddedPlatformSession(platformId)) {
      return null;
    }
    if (!isPlatformBrowserBridgeAvailable()) {
      return null;
    }
    await syncEmbeddedCookiesToKeychain(platformId);
    const loggedIn = await this.isEmbeddedPlatformLoggedIn(platformId, config);
    if (!loggedIn) {
      return null;
    }
    this.resetConnectAttempt(platformId);
    const state = await this.markConnected(platformId, config);
    await this.broadcastStatusChange(state);
    console.log(`[PlatformSessionService] Recovered ${platformId} from embedded Papr tab`);
    return state;
  }

  private clearLinkedInLiveValidationCache(): void {
    this.linkedInLiveValidationCache = null;
  }

  /**
   * Get status for all platforms
   */
  async getAllStatuses(): Promise<PlatformSessionState[]> {
    if (!this.initialized) await this.initialize();

    const statuses: PlatformSessionState[] = [];
    for (const platformId of getAllPlatformIds()) {
      statuses.push(await this.getStatus(platformId));
    }
    return statuses;
  }

  /**
   * Connect to a platform.
   * Chrome path: auto-extract if already logged in, otherwise open Chrome and poll.
   * Fallback: Playwright-controlled browser when Chrome isn't installed.
   */
  async connect(
    platformId: PlatformId,
  ): Promise<
    PlatformSessionState & {
      waitingForConfirmation?: boolean;
      externalChrome?: boolean;
      chromeWindowOpened?: boolean;
    }
  > {
    if (!this.initialized) await this.initialize();

    const config = getPlatformConfig(platformId);
    if (!config) {
      return {
        platformId,
        status: "disconnected",
        error: `Unknown platform: ${platformId}`,
      };
    }

    if (this.connectingPlatform && this.connectingPlatform !== platformId) {
      return {
        platformId,
        status: "disconnected",
        error: `Already connecting to ${this.connectingPlatform}. Please wait.`,
      };
    }

    const current = this.store.sessions[platformId];
    if (
      current?.status === "needs_reauth" ||
      current?.status === "expired" ||
      current?.status === "disconnected"
    ) {
      this.resetConnectAttempt(platformId);
      if (allowsEmbeddedPlatformSession(platformId)) {
        const recovered = await this.tryRecoverEmbeddedLogin(platformId, config);
        if (recovered) {
          return recovered;
        }
      }
    } else if (this.connectingPlatform === platformId) {
      this.resetConnectAttempt(platformId);
    }

    this.connectingPlatform = platformId;
    console.log(`[PlatformSessionService] Starting connect flow for ${platformId}`);

    try {
      if (isGoogleChromeInstalled()) {
        return await this.connectViaChrome(platformId, config);
      }

      if (isPlatformBrowserBridgeAvailable()) {
        return await this.connectViaEmbeddedTab(platformId, config);
      }

      console.log(`[PlatformSessionService] Chrome not installed, using Playwright fallback for ${platformId}`);
      return await this.connectViaPlaywright(platformId, config);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlatformSessionService] Connect failed for ${platformId}:`, errorMessage);
      this.connectingPlatform = null;

      return {
        platformId,
        status: "disconnected",
        error: errorMessage,
      };
    }
  }

  /**
   * Manual "Check now" while waiting for Chrome login to complete.
   */
  async confirmLogin(platformId: PlatformId): Promise<PlatformSessionState> {
    if (!this.initialized) await this.initialize();

    const config = getPlatformConfig(platformId);
    if (!config) {
      this.connectingPlatform = null;
      return {
        platformId,
        status: "disconnected",
        error: `Unknown platform: ${platformId}`,
      };
    }

    try {
      if (isGoogleChromeInstalled()) {
        const realChromeState = await this.tryConnectViaRealChromeProfile(platformId, config);
        if (realChromeState) {
          this.connectingPlatform = null;
          return realChromeState;
        }

        if (isPlatformBrowserBridgeAvailable()) {
          const embeddedRecovered = await this.tryRecoverEmbeddedLogin(platformId, config);
          if (embeddedRecovered) {
            return embeddedRecovered;
          }
        }

        const extracted = allowsPersonalChromeCookieImport(platformId)
          ? await this.tryExtractRequiredCookiesFromChrome(config)
          : { success: false as const, cookies: {}, missing: config.requiredCookies };
        if (extracted.success) {
          await this.persistChromeSession(
            platformId,
            config,
            extracted.cookies,
            await this.extractPlaywrightCookiesFromChrome(config),
          );
          this.stopChromeCookiePolling(platformId);
          const state = await this.markConnected(platformId, config);
          console.log(`[PlatformSessionService] Successfully connected ${platformId} via manual check`);
          return state;
        }

        throw new Error(
          platformId === "linkedin"
            ? "Finish signing in to LinkedIn in the Papr-managed Chrome window that opened, then try again."
            : `Finish logging in in the Chrome window that opened for ${config.name}, then try again.`,
        );
      }

      if (isPlatformBrowserBridgeAvailable()) {
        const embeddedState = await this.tryConnectViaImportedChromeCookiesInEmbeddedTab(
          platformId,
          config,
        );
        if (embeddedState) {
          this.connectingPlatform = null;
          return embeddedState;
        }

        const stateResponse = await requestPlatformBrowser({
          action: "get_state",
          payload: { platformId },
        });
        const embeddedUrl =
          stateResponse.success && stateResponse.data
            ? String((stateResponse.data as { url?: string }).url ?? "")
            : "";
        if (config.successUrlPattern.test(embeddedUrl)) {
          await syncEmbeddedCookiesToKeychain(platformId);
          this.stopChromeCookiePolling(platformId);
          this.connectingPlatform = null;
          const state = await this.markConnected(platformId, config);
          console.log(
            `[PlatformSessionService] Successfully connected ${platformId} via Papr tab`,
          );
          return state;
        }
      }

      throw new Error(`No login detected for ${config.name}. Finish sign-in, then try again.`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlatformSessionService] Confirm login failed for ${platformId}:`, errorMessage);

      return {
        platformId,
        status: "connecting",
        error: errorMessage,
      };
    }
  }

  private async tryConnectViaRealChromeProfile(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<PlatformSessionState | null> {
    const {
      getRealChromeSessionUrl,
      getRealChromeSessionCookies,
      buildRequiredCookieValuesFromPlaywright,
    } = await import("./platformAgentBrowser.js");

    const profileUrl = getRealChromeSessionUrl(platformId);
    const urlMatches =
      profileUrl !== null &&
      (config.successUrlPattern.test(profileUrl) || isAuthenticatedPlatformUrl(profileUrl, config));

    const cookies = await getRealChromeSessionCookies(platformId);
    const { values, missing } = buildRequiredCookieValuesFromPlaywright(config, cookies);
    const cookiesComplete = missing.length === 0;

    if (!urlMatches && !cookiesComplete) {
      return null;
    }

    if (cookiesComplete) {
      await this.persistChromeSession(platformId, config, values, cookies);
    } else if (allowsPersonalChromeCookieImport(platformId)) {
      const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
      if (!extracted.success) {
        return null;
      }
      await this.persistChromeSession(
        platformId,
        config,
        extracted.cookies,
        await this.extractPlaywrightCookiesFromChrome(config),
      );
    } else {
      return null;
    }

    this.stopChromeCookiePolling(platformId);
    const state = await this.markConnected(platformId, config);
    console.log(`[PlatformSessionService] Connected ${platformId} via Papr-managed Chrome profile`);
    return state;
  }

  private async connectViaChrome(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<
    PlatformSessionState & {
      waitingForConfirmation?: boolean;
      externalChrome?: boolean;
      chromeWindowOpened?: boolean;
    }
  > {
    const { openRealChromePlatformWindow } = await import("./platformAgentBrowser.js");

    if (allowsPersonalChromeCookieImport(platformId)) {
      const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
      const playwrightCookies = extracted.success
        ? await this.extractPlaywrightCookiesFromChrome(config)
        : [];

      if (extracted.success) {
        await this.persistChromeSession(
          platformId,
          config,
          extracted.cookies,
          playwrightCookies,
        );
        await openRealChromePlatformWindow(
          platformId,
          config.homeUrl,
          playwrightCookies.length > 0 ? playwrightCookies : undefined,
        );
        this.connectingPlatform = null;
        const state = await this.markConnected(platformId, config);
        console.log(
          `[PlatformSessionService] Connected ${platformId} — opened Papr Chrome with session imported from your Chrome`,
        );
        return {
          ...state,
          externalChrome: true,
          chromeWindowOpened: true,
        };
      }
    } else {
      console.log(
        `[PlatformSessionService] ${config.name} requires sign-in in Papr-managed Chrome (personal Chrome import disabled)`,
      );
    }

    await openRealChromePlatformWindow(platformId, config.loginUrl);
    console.log(
      `[PlatformSessionService] Opened ${config.loginUrl} in Papr-managed Chrome for ${platformId}`,
    );

    this.startChromeCookiePolling(platformId, config, { includeRealChromeProfile: true });

    return {
      platformId,
      status: "connecting",
      waitingForConfirmation: true,
      externalChrome: true,
      chromeWindowOpened: true,
    };
  }

  private async connectViaPlaywright(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<PlatformSessionState> {
    const profilePath = this.getProfilePath(platformId);
    await fs.mkdir(profilePath, { recursive: true });

    const playwright = await loadPlaywright();

    let browserType: "chrome" | "chromium" = "chromium";
    if (isGoogleChromeInstalled()) {
      browserType = "chrome";
    }

    const userDataDir = join(profilePath, "browser-data");
    await fs.mkdir(userDataDir, { recursive: true });

    this.activeContext = await playwright.chromium.launchPersistentContext(
      userDataDir,
      buildRealChromePersistentLaunchOptions({
        includeCdpPort: false,
        channel: browserType,
      }),
    );
    await applyRealChromeStealthScripts(this.activeContext);

    const page = this.activeContext.pages()[0] || (await this.activeContext.newPage());
    await page.goto(config.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const startTime = Date.now();
    let loggedIn = false;

    while (Date.now() - startTime < CONNECT_TIMEOUT_MS) {
      const currentUrl = page.url();
      if (config.successUrlPattern.test(currentUrl)) {
        loggedIn = true;
        console.log(`[PlatformSessionService] Login detected for ${platformId}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (!loggedIn) {
      throw new Error(
        "Login timed out. Please try again and complete the login within 5 minutes.",
      );
    }

    try {
      await this.extractAndStoreCookies(platformId, config);

      const allCookies = await this.activeContext.cookies();
      await fs.writeFile(join(profilePath, "cookies.json"), JSON.stringify(allCookies, null, 2));

      this.connectingPlatform = null;
      return this.markConnected(platformId, config);
    } finally {
      await this.closeBrowser();
    }
  }

  private startChromeCookiePolling(
    platformId: PlatformId,
    config: PlatformConfig,
    options?: { includeRealChromeProfile?: boolean },
  ): void {
    this.stopChromeCookiePolling(platformId);
    this.cookiePollStartedAt.set(platformId, Date.now());

    const poll = async (): Promise<void> => {
      const startedAt = this.cookiePollStartedAt.get(platformId) ?? Date.now();
      if (Date.now() - startedAt > CONNECT_TIMEOUT_MS) {
        this.stopChromeCookiePolling(platformId);
        this.connectingPlatform = null;
        return;
      }

      try {
        if (options?.includeRealChromeProfile) {
          const connected = await this.tryConnectViaRealChromeProfile(platformId, config);
          if (connected) {
            this.stopChromeCookiePolling(platformId);
            this.connectingPlatform = null;
            await this.broadcastStatusChange(connected);
            console.log(`[PlatformSessionService] Auto-detected real Chrome login for ${platformId}`);
            return;
          }
        }

        if (allowsPersonalChromeCookieImport(platformId)) {
          const extracted = await this.tryExtractRequiredCookiesFromChrome(config, {
            useCache: true,
          });
          if (!extracted.success) return;

          await this.persistChromeSession(
            platformId,
            config,
            extracted.cookies,
            await this.extractPlaywrightCookiesFromChrome(config),
          );
          this.stopChromeCookiePolling(platformId);
          this.connectingPlatform = null;
          const state = await this.markConnected(platformId, config);
          await this.broadcastStatusChange(state);
          console.log(`[PlatformSessionService] Auto-detected Chrome login for ${platformId}`);
        }
      } catch (error) {
        console.warn(`[PlatformSessionService] Chrome cookie poll failed for ${platformId}:`, error);
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, CHROME_COOKIE_POLL_MS);
    this.cookiePollTimers.set(platformId, timer);
  }

  private stopChromeCookiePolling(platformId: PlatformId): void {
    const timer = this.cookiePollTimers.get(platformId);
    if (timer) {
      clearInterval(timer);
      this.cookiePollTimers.delete(platformId);
    }
    this.cookiePollStartedAt.delete(platformId);
  }

  private async broadcastStatusChange(state: PlatformSessionState): Promise<void> {
    const { broadcast } = await import("../../websocket/index.js");
    broadcast({
      type: "platform:status-changed",
      data: state,
    });
  }

  private async markConnected(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<PlatformSessionState> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionDurationDays * 24 * 60 * 60 * 1000);

    this.store.sessions[platformId] = {
      platformId,
      status: "connected",
      connectedAt: now.toISOString(),
      lastRefreshedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    await this.saveStore();
    if (platformId === "linkedin") {
      this.linkedInLiveValidationCache = {
        validatedAt: Date.now(),
        status: this.store.sessions[platformId],
      };
    }
    return this.store.sessions[platformId];
  }

  private async writeCookiesJson(
    platformId: PlatformId,
    cookies: Cookie[],
  ): Promise<void> {
    const profilePath = this.getProfilePath(platformId);
    await fs.mkdir(profilePath, { recursive: true });
    await fs.writeFile(
      join(profilePath, "cookies.json"),
      JSON.stringify(cookies, null, 2),
    );
  }

  private getChromeCookieNames(config: PlatformConfig): string[] {
    return [...config.requiredCookies, ...(config.optionalCookies ?? [])];
  }

  /**
   * Extract Playwright-ready cookies from Chrome with real host_key domains.
   */
  private async extractPlaywrightCookiesFromChrome(
    config: PlatformConfig,
  ): Promise<Cookie[]> {
    const { getCookiesPromised } = await import("chrome-cookies-secure");
    const wantedNames = new Set(
      this.getChromeCookieNames(config).map((name) => name.toLowerCase()),
    );
    const merged = new Map<string, Cookie>();

    for (const url of this.getChromeCookieUrls(config)) {
      if (
        config.requiredCookies.length > 0 &&
        hasRequiredPlaywrightCookies(
          [...merged.values()],
          config.requiredCookies,
        )
      ) {
        break;
      }

      try {
        const raw = (await getCookiesPromised(
          url,
          "puppeteer",
        )) as ChromePuppeteerCookie[];
        for (const rawCookie of raw) {
          if (
            wantedNames.size > 0 &&
            !wantedNames.has(rawCookie.name.toLowerCase())
          ) {
            continue;
          }
          if (!merged.has(rawCookie.name)) {
            merged.set(rawCookie.name, chromePuppeteerToPlaywright(rawCookie));
          }
        }
      } catch (urlError) {
        console.warn(
          `[PlatformSessionService] Playwright cookie read failed for ${url}:`,
          urlError,
        );
      }
    }

    return [...merged.values()];
  }

  private async persistChromeSession(
    platformId: PlatformId,
    config: PlatformConfig,
    cookieValues: Record<string, string>,
    playwrightCookies?: Cookie[],
  ): Promise<void> {
    await this.storeRequiredCookies(platformId, config, cookieValues);

    const cookiesToPersist =
      playwrightCookies ??
      buildPlaywrightCookiesFromKeychainValues(config, cookieValues);

    if (cookiesToPersist.length > 0) {
      await this.writeCookiesJson(platformId, cookiesToPersist);
    }
  }

  /** Sync cookies from the in-app platform browser tab into keychain + cookies.json */
  async persistEmbeddedSession(
    platformId: PlatformId,
    config: PlatformConfig,
    cookieValues: Record<string, string>,
    rawCookies: Array<{ name: string; value: string; domain?: string }>,
  ): Promise<void> {
    await this.storeRequiredCookies(platformId, config, cookieValues);

    const playwrightCookies: Cookie[] = rawCookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain:
        cookie.domain ??
        getPlaywrightCookieDomain(config, cookie.name),
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    }));

    if (playwrightCookies.length > 0) {
      await this.writeCookiesJson(platformId, playwrightCookies);
    }
  }

  private async tryConnectViaImportedChromeCookiesInEmbeddedTab(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<PlatformSessionState | null> {
    if (!isGoogleChromeInstalled()) {
      return null;
    }

    if (!allowsPersonalChromeCookieImport(platformId)) {
      return null;
    }

    const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
    if (!extracted.success) {
      return null;
    }

    const playwrightCookies = await this.extractPlaywrightCookiesFromChrome(config);
    if (playwrightCookies.length === 0) {
      return null;
    }

    const injectResponse = await requestPlatformBrowser({
      action: "inject_cookies",
      payload: { platformId, cookies: playwrightCookies },
    });
    if (!injectResponse.success) {
      console.warn(
        `[PlatformSessionService] Failed to inject Chrome cookies for ${platformId}:`,
        injectResponse.error,
      );
      return null;
    }

    const ensureResponse = await requestPlatformBrowser({
      action: "ensure",
      payload: { platformId, url: config.homeUrl },
    });
    if (!ensureResponse.success) {
      return null;
    }

    const stateResponse = await requestPlatformBrowser({
      action: "get_state",
      payload: { platformId },
    });
    const currentUrl =
      stateResponse.success && stateResponse.data
        ? String((stateResponse.data as { url?: string }).url ?? "")
        : "";

    if (platformId === "linkedin") {
      if (!isAuthenticatedPlatformUrl(currentUrl, config)) {
        console.log(
          `[PlatformSessionService] Chrome cookies for ${platformId} not authenticated in Papr tab:`,
          currentUrl,
        );
        return null;
      }
    } else if (!isAuthenticatedPlatformUrl(currentUrl, config)) {
      return null;
    }

    await this.persistChromeSession(platformId, config, extracted.cookies, playwrightCookies);
    await syncEmbeddedCookiesToKeychain(platformId);
    const state = await this.markConnected(platformId, config);
    console.log(
      `[PlatformSessionService] Connected ${platformId} using Chrome cookies imported into Papr tab`,
    );
    return state;
  }

  private async connectViaEmbeddedTab(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<PlatformSessionState & { waitingForConfirmation?: boolean }> {
    const stateResponse = await requestPlatformBrowser({
      action: "get_state",
      payload: { platformId },
    });
    const existingUrl =
      stateResponse.success && stateResponse.data
        ? String((stateResponse.data as { url?: string }).url ?? "")
        : "";

    if (isAuthenticatedPlatformUrl(existingUrl, config)) {
      await syncEmbeddedCookiesToKeychain(platformId);
      this.connectingPlatform = null;
      const state = await this.markConnected(platformId, config);
      console.log(`[PlatformSessionService] Connected ${platformId} using existing Papr tab session`);
      return state;
    }

    const importedState =
      allowsPersonalChromeCookieImport(platformId)
        ? await this.tryConnectViaImportedChromeCookiesInEmbeddedTab(platformId, config)
        : null;
    if (importedState) {
      this.connectingPlatform = null;
      return importedState;
    }

    await requestPlatformBrowser({
      action: "ensure",
      payload: { platformId, url: config.loginUrl },
    });
    await requestPlatformBrowser({
      action: "show_tab",
      payload: { platformId },
    });

    console.log(`[PlatformSessionService] Opened ${config.loginUrl} in Papr ${config.name} tab`);
    this.startEmbeddedLoginPolling(platformId, config);

    return {
      platformId,
      status: "connecting",
      waitingForConfirmation: true,
    };
  }

  private startEmbeddedLoginPolling(
    platformId: PlatformId,
    config: PlatformConfig,
  ): void {
    this.stopChromeCookiePolling(platformId);
    this.cookiePollStartedAt.set(platformId, Date.now());

    const poll = async (): Promise<void> => {
      const startedAt = this.cookiePollStartedAt.get(platformId) ?? Date.now();
      if (Date.now() - startedAt > CONNECT_TIMEOUT_MS) {
        this.stopChromeCookiePolling(platformId);
        this.connectingPlatform = null;
        return;
      }

      try {
        const stateResponse = await requestPlatformBrowser({
          action: "get_state",
          payload: { platformId },
        });
        if (!stateResponse.success || !stateResponse.data) {
          return;
        }
        const url = String((stateResponse.data as { url?: string }).url ?? "");
        if (!isAuthenticatedPlatformUrl(url, config)) {
          return;
        }

        await syncEmbeddedCookiesToKeychain(platformId);
        this.stopChromeCookiePolling(platformId);
        this.connectingPlatform = null;
        const state = await this.markConnected(platformId, config);
        await this.broadcastStatusChange(state);
        console.log(`[PlatformSessionService] Auto-detected Papr tab login for ${platformId}`);
      } catch (error) {
        console.warn(
          `[PlatformSessionService] Embedded login poll failed for ${platformId}:`,
          error,
        );
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, CHROME_COOKIE_POLL_MS);
    this.cookiePollTimers.set(platformId, timer);
  }

  private getChromeCookieUrls(config: PlatformConfig): string[] {
    const bareDomain = config.cookieDomain.replace(/^\./, "");
    const urls: string[] = [config.homeUrl, config.loginUrl];

    for (const domain of config.additionalDomains ?? []) {
      const bare = domain.replace(/^\./, "");
      urls.push(`https://www.${bare}/`, `https://${bare}/`);
    }

    // www subdomain before bare domain — session cookies are often www-scoped
    urls.push(`https://www.${bareDomain}/`, `https://${bareDomain}/`);

    return [...new Set(urls)];
  }

  private hasRequiredCookies(
    cookies: Map<string, string>,
    requiredCookies: string[],
  ): boolean {
    return requiredCookies.every((name) =>
      [...cookies.keys()].some((key) => key.toLowerCase() === name.toLowerCase()),
    );
  }

  private async tryExtractRequiredCookiesFromChrome(
    config: PlatformConfig,
    options?: { useCache?: boolean },
  ): Promise<{ success: boolean; cookies: Record<string, string>; missing: string[] }> {
    const allCookies = await this.extractCookiesFromChrome(config, {
      requiredCookies: config.requiredCookies,
      useCache: options?.useCache,
    });
    const cookies: Record<string, string> = {};
    const missing: string[] = [];

    for (const cookieName of config.requiredCookies) {
      const cookie = allCookies.find((c) => c.name.toLowerCase() === cookieName.toLowerCase());
      if (cookie?.value) {
        cookies[cookieName] = cookie.value;
      } else {
        missing.push(cookieName);
      }
    }

    if (config.isCustom && config.requiredCookies.length === 0) {
      for (const cookie of allCookies) {
        cookies[cookie.name] = cookie.value;
      }
      return {
        success: allCookies.length > 0,
        cookies,
        missing: [],
      };
    }

    return {
      success: missing.length === 0,
      cookies,
      missing,
    };
  }

  private async storeRequiredCookies(
    platformId: PlatformId,
    config: PlatformConfig,
    cookies: Record<string, string>,
  ): Promise<void> {
    const keysService = getCustomKeysService();
    const existingKeys = await keysService.listKeys();

    for (const [cookieName, cookieValue] of Object.entries(cookies)) {
      const keyName = getPlatformKeyName(platformId, cookieName);
      const existing = existingKeys.find((k) => k.name === keyName);
      if (existing) {
        try {
          const currentValue = await keysService.getKeyByName(keyName);
          if (currentValue === cookieValue) {
            continue;
          }
        } catch {
          /* value unreadable — refresh below */
        }
        await keysService.deleteKey(keyName);
      }

      await keysService.addKey({
        name: keyName,
        value: cookieValue,
        description: `${config.name} session cookie (auto-managed by Platform Connections)`,
        permission: "always",
        orgScope: "all",
      });
    }
  }

  /**
   * Extract cookies from Chrome's database for a platform.
   * Tries URLs in priority order and stops once required cookies are found
   * to minimize macOS keychain prompts (each read may ask for "Chrome Safe Storage").
   */
  private async extractCookiesFromChrome(
    config: PlatformConfig,
    options?: { requiredCookies?: string[]; useCache?: boolean },
  ): Promise<Array<{ name: string; value: string }>> {
    const requiredCookies = options?.requiredCookies ?? [];

    if (options?.useCache && this.chromeCookieCache?.platformId === config.id) {
      const age = Date.now() - this.chromeCookieCache.fetchedAt;
      if (age < CHROME_COOKIE_CACHE_MS) {
        return [...this.chromeCookieCache.cookies.entries()].map(([name, value]) => ({
          name,
          value,
        }));
      }
    }

    try {
      const { getCookiesPromised } = await import("chrome-cookies-secure");
      const merged = new Map<string, string>();

      for (const url of this.getChromeCookieUrls(config)) {
        if (requiredCookies.length > 0 && this.hasRequiredCookies(merged, requiredCookies)) {
          break;
        }

        try {
          const cookies = await getCookiesPromised(url, "object");
          for (const [name, value] of Object.entries(cookies)) {
            merged.set(name, String(value));
          }
        } catch (urlError) {
          console.warn(`[PlatformSessionService] Cookie read failed for ${url}:`, urlError);
        }
      }

      if (options?.useCache) {
        this.chromeCookieCache = {
          platformId: config.id as PlatformId,
          cookies: merged,
          fetchedAt: Date.now(),
        };
      }

      const cookieArray = [...merged.entries()].map(([name, value]) => ({ name, value }));
      console.log(
        `[PlatformSessionService] Extracted ${cookieArray.length} cookies from Chrome for ${config.name}`,
      );
      return cookieArray;
    } catch (error) {
      console.error("[PlatformSessionService] Failed to extract Chrome cookies:", error);
      throw new Error(
        `Failed to read Chrome cookies. Make sure Chrome is installed and you're logged into ${config.name}. ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Disconnect from a platform - removes cookies from keychain
   */
  async disconnect(platformId: PlatformId): Promise<PlatformSessionState> {
    if (!this.initialized) await this.initialize();

    const config = getPlatformConfig(platformId);
    if (!config) {
      return {
        platformId,
        status: "disconnected",
        error: `Unknown platform: ${platformId}`,
      };
    }

    console.log(`[PlatformSessionService] Disconnecting ${platformId}`);
    this.stopChromeCookiePolling(platformId);
    this.chromeCookieCache = null;

    try {
      // Delete cookies from keychain
      const keysService = getCustomKeysService();
      if (config.isCustom) {
        const existingKeys = await keysService.listKeys();
        const prefix = `${config.keyPrefix}_`;
        for (const key of existingKeys) {
          if (key.name.startsWith(prefix)) {
            try {
              await keysService.deleteKey(key.name);
            } catch {
              /* key may already be gone */
            }
          }
        }
      } else {
        for (const cookieName of config.requiredCookies) {
          const keyName = getPlatformKeyName(platformId, cookieName);
          try {
            await keysService.deleteKey(keyName);
          } catch {
            // Key might not exist - that's fine
          }
        }
      }

      // Clear browser profile
      const profilePath = this.getProfilePath(platformId);
      try {
        await fs.rm(profilePath, { recursive: true, force: true });
      } catch {
        // Profile might not exist
      }

      // Update state
      this.store.sessions[platformId] = {
        platformId,
        status: "disconnected",
      };
      await this.saveStore();

      console.log(`[PlatformSessionService] Successfully disconnected ${platformId}`);
      return this.store.sessions[platformId];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlatformSessionService] Disconnect failed for ${platformId}:`, errorMessage);

      return {
        platformId,
        status: "disconnected",
        error: errorMessage,
      };
    }
  }

  /**
   * LinkedIn refresh uses Papr-spawned Chrome or stored Papr session only — never personal Chrome.
   */
  private async refreshLinkedInFromPaprChrome(
    config: PlatformConfig,
  ): Promise<PlatformSessionState> {
    const platformId = "linkedin" as PlatformId;
    const {
      getRealChromeSessionUrl,
      getRealChromeSessionCookies,
      buildRequiredCookieValuesFromPlaywright,
    } = await import("./platformAgentBrowser.js");

    const liveCookies = await getRealChromeSessionCookies(platformId);
    const { values: liveValues, missing: liveMissing } =
      buildRequiredCookieValuesFromPlaywright(config, liveCookies);

    const chromeUrl = getRealChromeSessionUrl(platformId);
    if (chromeUrl && isLoggedOutPlatformUrl(chromeUrl)) {
      return this.markNeedsReauth(platformId, "redirected to login in Papr Chrome");
    }

    if (liveMissing.length === 0) {
      await this.persistChromeSession(platformId, config, liveValues, liveCookies);
      const now = new Date();
      this.store.sessions[platformId] = {
        ...this.store.sessions[platformId],
        lastRefreshedAt: now.toISOString(),
        status: "connected",
        error: undefined,
      };
      await this.saveStore();
      console.log("[PlatformSessionService] Refreshed LinkedIn from Papr-managed Chrome");
      return this.store.sessions[platformId];
    }

    const storedCookies = await this.loadCookiesForPlaywright(platformId, config);
    if (storedCookies.length === 0) {
      throw new Error(
        "No LinkedIn session in Papr Chrome. Disconnect and Connect again, then sign in in the Papr-managed Chrome window.",
      );
    }

    const now = new Date();
    this.store.sessions[platformId] = {
      ...this.store.sessions[platformId],
      lastRefreshedAt: now.toISOString(),
      status: "connected",
      error: undefined,
    };
    await this.saveStore();
    console.log("[PlatformSessionService] Refreshed LinkedIn from stored Papr session");
    return this.store.sessions[platformId];
  }

  /**
   * Refresh a platform session - headless cookie extraction
   */
  async refresh(platformId: PlatformId): Promise<PlatformSessionState> {
    if (!this.initialized) await this.initialize();

    const config = getPlatformConfig(platformId);
    if (!config) {
      return {
        platformId,
        status: "disconnected",
        error: `Unknown platform: ${platformId}`,
      };
    }

    const current = await this.getStatus(platformId);
    if (current.status === "disconnected") {
      return {
        platformId,
        status: "disconnected",
        error: "Platform not connected. Use connect() first.",
      };
    }

    console.log(`[PlatformSessionService] Refreshing session for ${platformId}`);

    try {
      if (platformId === "linkedin") {
        return await this.refreshLinkedInFromPaprChrome(config);
      }

      if (isPlatformBrowserBridgeAvailable()) {
        await syncEmbeddedCookiesToKeychain(platformId);
        const embeddedLoggedIn = await this.isEmbeddedPlatformLoggedIn(platformId, config);
        if (embeddedLoggedIn) {
          const refreshNow = new Date();
          this.store.sessions[platformId] = {
            ...this.store.sessions[platformId],
            lastRefreshedAt: refreshNow.toISOString(),
            status: "connected",
            error: undefined,
          };
          await this.saveStore();
          console.log(`[PlatformSessionService] Refreshed ${platformId} from Papr tab cookies`);
          return this.store.sessions[platformId];
        }
      }

      if (isGoogleChromeInstalled() && allowsPersonalChromeCookieImport(platformId)) {
        const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
          if (extracted.success) {
          const playwrightCookies = await this.extractPlaywrightCookiesFromChrome(config);
          await this.persistChromeSession(
            platformId,
            config,
            extracted.cookies,
            playwrightCookies,
          );

          const now = new Date();
          this.store.sessions[platformId] = {
            ...this.store.sessions[platformId],
            lastRefreshedAt: now.toISOString(),
            status: "connected",
            error: undefined,
          };
          await this.saveStore();
          console.log(`[PlatformSessionService] Refreshed ${platformId} from Chrome cookies`);
          return this.store.sessions[platformId];
        }
      }

      const existingCookies = await this.loadCookiesForPlaywright(platformId, config);
      if (existingCookies.length === 0) {
        throw new Error("No stored cookies found. Please reconnect.");
      }

      const playwright = await loadPlaywright();
      const refreshLaunchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
        headless: true,
      };
      if (isGoogleChromeInstalled()) {
        refreshLaunchOptions.channel = "chrome";
      }
      this.activeBrowser = await playwright.chromium.launch(refreshLaunchOptions);

      this.activeContext = await this.activeBrowser.newContext({});

      // Add existing cookies
      await this.activeContext.addCookies(existingCookies);

      const page = await this.activeContext.newPage();

      // Navigate to trigger cookie refresh
      await page.goto(config.homeUrl, {
        waitUntil: "domcontentloaded",
        timeout: REFRESH_TIMEOUT_MS,
      });

      // Check if still logged in
      const currentUrl = page.url();
      if (
        currentUrl.includes("login") ||
        currentUrl.includes("signin") ||
        currentUrl.includes("checkpoint")
      ) {
        throw new Error("Session expired or requires re-authentication");
      }

      // Extract fresh cookies
      await this.extractAndStoreCookies(platformId, config);

      // Save updated cookies for Playwright fallback flows
      const profilePath = this.getProfilePath(platformId);
      const allCookies = await this.activeContext.cookies();
      await fs.writeFile(join(profilePath, "cookies.json"), JSON.stringify(allCookies, null, 2));

      // Update state
      const now = new Date();
      this.store.sessions[platformId] = {
        ...this.store.sessions[platformId],
        lastRefreshedAt: now.toISOString(),
        status: "connected",
        error: undefined,
      };
      await this.saveStore();

      console.log(`[PlatformSessionService] Successfully refreshed ${platformId}`);
      return this.store.sessions[platformId];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlatformSessionService] Refresh failed for ${platformId}:`, errorMessage);

      // Update status to needs_reauth
      this.store.sessions[platformId] = {
        ...this.store.sessions[platformId],
        status: "needs_reauth",
        error: errorMessage,
      };
      await this.saveStore();

      return this.store.sessions[platformId];
    } finally {
      await this.closeBrowser();
    }
  }

  /**
   * Mark platform session as needing user reconnect (dead cookies, redirect loop).
   */
  async markNeedsReauth(platformId: PlatformId, error: string): Promise<PlatformSessionState> {
    if (!this.initialized) {
      await this.initialize();
    }
    const displayError =
      platformId === "linkedin" ? sanitizeLinkedInProbeErrorForDisplay(error) : error;
    const stored = this.store.sessions[platformId];
    this.store.sessions[platformId] = {
      ...(stored ?? { platformId }),
      platformId,
      status: "needs_reauth",
      error: displayError,
    };
    await this.saveStore();
    await this.broadcastStatusChange(this.store.sessions[platformId]);
    console.warn(`[PlatformSessionService] ${platformId} marked needs_reauth: ${displayError}`);
    this.clearLinkedInLiveValidationCache();
    return this.store.sessions[platformId];
  }

  /**
   * Persistent Chrome user-data directory for agent automation (desktop LinkedIn).
   */
  getBrowserDataDir(platformId: PlatformId): string {
    return join(this.getProfilePath(platformId), "browser-data");
  }

  /**
   * Import full Playwright cookie set from the user's Google Chrome login.
   */
  async importPlaywrightCookiesFromChrome(platformId: PlatformId): Promise<Cookie[]> {
    if (!this.initialized) {
      await this.initialize();
    }
    const config = getPlatformConfig(platformId);
    if (!config || !isGoogleChromeInstalled()) {
      return [];
    }

    if (!allowsPersonalChromeCookieImport(platformId)) {
      return [];
    }

    const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
    if (!extracted.success) {
      return [];
    }

    const playwrightCookies = await this.extractPlaywrightCookiesFromChrome(config);
    await this.persistChromeSession(
      platformId,
      config,
      extracted.cookies,
      playwrightCookies,
    );
    return playwrightCookies;
  }

  /**
   * Load session cookies for agent browser automation (keychain or saved profile).
   */
  async getSessionCookiesForBrowser(platformId: PlatformId): Promise<Cookie[]> {
    if (!this.initialized) await this.initialize();
    const config = getPlatformConfig(platformId);
    if (!config) {
      throw new Error(`Unknown platform: ${platformId}`);
    }
    return this.loadCookiesForPlaywright(platformId, config);
  }

  /**
   * Load cookies for Playwright from saved profile or keychain
   */
  private async loadCookiesForPlaywright(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<Cookie[]> {
    const profilePath = this.getProfilePath(platformId);
    const cookiesPath = join(profilePath, "cookies.json");

    try {
      const cookiesData = await fs.readFile(cookiesPath, "utf-8");
      const parsed = JSON.parse(cookiesData) as Cookie[];
      if (parsed.length > 0) {
        const keysService = getCustomKeysService();
        const keychainValues: Record<string, string> = {};
        for (const cookieName of config.requiredCookies) {
          const keyName = getPlatformKeyName(platformId, cookieName);
          const value = await keysService.getKeyByName(keyName);
          if (value) {
            keychainValues[cookieName] = value;
          }
        }

        const { cookies: repaired, repaired: wasRepaired } =
          repairPlaywrightCookieDomains(parsed, config, keychainValues);
        if (wasRepaired) {
          await this.writeCookiesJson(platformId, repaired);
          console.log(
            `[PlatformSessionService] Synced cookie values/domains for ${platformId} from keychain`,
          );
        }
        return repaired;
      }
    } catch {
      // Fall back to keychain
    }

    const keysService = getCustomKeysService();
    const values: Record<string, string> = {};

    for (const cookieName of [
      ...config.requiredCookies,
      ...(config.optionalCookies ?? []),
    ]) {
      const keyName = getPlatformKeyName(platformId, cookieName);
      const value = await keysService.getKeyByName(keyName);
      if (value) {
        values[cookieName] = value;
      }
    }

    for (const cookieName of config.requiredCookies) {
      if (!values[cookieName]) {
        return [];
      }
    }

    return buildPlaywrightCookiesFromKeychainValues(config, values);
  }

  /**
   * Extract required cookies and store in keychain
   */
  private async extractAndStoreCookies(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<void> {
    if (!this.activeContext) {
      throw new Error("No active browser context");
    }

    const allCookies = await this.activeContext.cookies();
    const keysService = getCustomKeysService();

    // Filter for this platform's domain
    const platformCookies = allCookies.filter(
      (c) =>
        c.domain.includes(config.cookieDomain.replace(".", "")) ||
        config.additionalDomains?.some((d) => c.domain.includes(d.replace(".", ""))),
    );

    // Find and store required cookies
    for (const cookieName of config.requiredCookies) {
      const cookie = platformCookies.find((c) => c.name === cookieName);
      if (!cookie) {
        console.warn(
          `[PlatformSessionService] Required cookie "${cookieName}" not found for ${platformId}`,
        );
        continue;
      }

      const keyName = getPlatformKeyName(platformId, cookieName);

      // Check if key exists and update, or create new
      try {
        const existingKeys = await keysService.listKeys();
        const existing = existingKeys.find((k) => k.name === keyName);

        if (existing) {
          try {
            const currentValue = await keysService.getKeyByName(keyName);
            if (currentValue === cookie.value) {
              continue;
            }
          } catch {
            /* refresh below */
          }
          await keysService.deleteKey(keyName);
        }

        await keysService.addKey({
          name: keyName,
          value: cookie.value,
          description: `${config.name} session cookie (auto-managed by Connected Platforms)`,
          permission: "always", // Jobs need access without prompting
          orgScope: "all", // Store in shared vault so keys are accessible from any org
        });

        console.log(`[PlatformSessionService] Stored cookie ${keyName}`);
      } catch (error) {
        console.error(`[PlatformSessionService] Failed to store cookie ${keyName}:`, error);
        throw error;
      }
    }
  }

  /**
   * Verify all required cookies exist in keychain
   */
  private async verifyPlatformCookies(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<boolean> {
    if (config.isCustom) {
      const cookiesPath = join(this.getProfilePath(platformId), "cookies.json");
      try {
        const raw = await fs.readFile(cookiesPath, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          return true;
        }
      } catch {
        /* fall through to keychain prefix check */
      }

      const keysService = getCustomKeysService();
      const prefix = `${config.keyPrefix}_`;
      try {
        const keys = await keysService.listKeys();
        return keys.some((key) => key.name.startsWith(prefix));
      } catch {
        return false;
      }
    }

    const keysService = getCustomKeysService();

    for (const cookieName of config.requiredCookies) {
      const keyName = getPlatformKeyName(platformId, cookieName);
      try {
        const value = await keysService.getKeyByName(keyName);
        if (!value) return false;
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * Open a visible authenticated browser for the platform
   * Returns the browser page for agent interaction (scraping, automation)
   */
  async openAuthenticatedBrowser(
    platformId: PlatformId,
    url?: string,
  ): Promise<{ success: boolean; message: string; error?: string }> {
    if (!this.initialized) await this.initialize();

    const config = getPlatformConfig(platformId);
    if (!config) {
      return {
        success: false,
        message: `Unknown platform: ${platformId}`,
        error: `Unknown platform: ${platformId}`,
      };
    }

    // LinkedIn: use Papr-managed Chrome (never a separate Playwright window with injected cookies).
    if (platformId === "linkedin" && isGoogleChromeInstalled()) {
      const { openRealChromePlatformWindow } = await import(
        "./platformAgentBrowser.js"
      );
      const targetUrl = url || config.homeUrl;
      await openRealChromePlatformWindow(platformId, targetUrl);
      return {
        success: true,
        message: `Opened ${config.name} in Papr-managed Chrome at ${targetUrl}. For agent automation use prepare_browser instead.`,
      };
    }

    // Check if we have stored cookies
    const existingCookies = await this.loadCookiesForPlaywright(platformId, config);
    if (existingCookies.length === 0) {
      return {
        success: false,
        message: `No stored session for ${config.name}. Use action="connect" first.`,
        error: "No stored cookies found",
      };
    }

    // Close any existing browser
    await this.closeBrowser();

    console.log(`[PlatformSessionService] Opening authenticated browser for ${platformId}`);

    try {
      const playwright = await loadPlaywright();
      const browseLaunchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
        headless: false,
      };
      if (isGoogleChromeInstalled()) {
        browseLaunchOptions.channel = "chrome";
      }
      this.activeBrowser = await playwright.chromium.launch(browseLaunchOptions);

      this.activeContext = await this.activeBrowser.newContext({
        viewport: { width: 1280, height: 800 },
      });

      // Load stored cookies
      await this.activeContext.addCookies(existingCookies);

      const page = await this.activeContext.newPage();
      const targetUrl = url || config.homeUrl;
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      // Check if we're still logged in
      const currentUrl = page.url();
      if (
        currentUrl.includes("login") ||
        currentUrl.includes("signin") ||
        currentUrl.includes("checkpoint")
      ) {
        await this.closeBrowser();
        return {
          success: false,
          message: `Session expired for ${config.name}. Please reconnect via Settings → Platforms.`,
          error: "Session expired - redirected to login",
        };
      }

      console.log(`[PlatformSessionService] Authenticated browser opened for ${platformId} at ${targetUrl}`);

      return {
        success: true,
        message: `Opened authenticated ${config.name} browser at ${targetUrl}. The browser window is now visible and logged into your account. You can navigate using browser tools or let the user interact directly.`,
      };
    } catch (error) {
      await this.closeBrowser();
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlatformSessionService] Failed to open browser for ${platformId}:`, errorMessage);
      return {
        success: false,
        message: `Failed to open browser: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  /**
   * Close any active browser
   */
  private async closeBrowser(): Promise<void> {
    try {
      if (this.activeContext) {
        await this.activeContext.close();
        this.activeContext = null;
      }
      if (this.activeBrowser) {
        await this.activeBrowser.close();
        this.activeBrowser = null;
      }
    } catch (error) {
      console.error("[PlatformSessionService] Error closing browser:", error);
    }
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    await this.closeBrowser();
    console.log("[PlatformSessionService] Shutdown complete");
  }
}

// Singleton instance
let platformSessionServiceInstance: PlatformSessionService | null = null;

/**
 * Get or create PlatformSessionService singleton
 */
export function getPlatformSessionService(): PlatformSessionService {
  if (!platformSessionServiceInstance) {
    platformSessionServiceInstance = new PlatformSessionService();
  }
  return platformSessionServiceInstance;
}
