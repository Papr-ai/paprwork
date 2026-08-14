/**
 * Platform Session Service
 *
 * Manages browser profiles, cookie extraction, and session storage for social platforms.
 *
 * Connection flow (Chrome preferred):
 * 1. Try reading cookies from Chrome immediately (works if already logged in)
 * 2. If missing, open Chrome for login (OAuth works normally)
 * 3. Poll Chrome's cookie database until session appears
 * 4. Fall back to Playwright-controlled browser if Chrome isn't installed
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
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

const execAsync = promisify(exec);
const CHROME_COOKIE_POLL_MS = 10_000; // 10s — each read can trigger a macOS keychain prompt
const CHROME_COOKIE_CACHE_MS = 20_000;

function isChromeInstalled(): boolean {
  if (process.platform === "darwin") {
    return existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return (
      existsSync(join(localAppData, "Google", "Chrome", "Application", "chrome.exe")) ||
      existsSync(join(programFiles, "Google", "Chrome", "Application", "chrome.exe"))
    );
  }
  try {
    execSync("which google-chrome || which google-chrome-stable", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function openInChrome(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execAsync(`open -a "Google Chrome" "${url}"`);
    return;
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const chromePath = join(localAppData, "Google", "Chrome", "Application", "chrome.exe");
    if (existsSync(chromePath)) {
      await execAsync(`"${chromePath}" "${url}"`);
      return;
    }
    await execAsync(`start chrome "${url}"`);
    return;
  }
  await execAsync(`google-chrome "${url}" || google-chrome-stable "${url}" || xdg-open "${url}"`);
}

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

  constructor() {
    this.storePath = join(getPaprDataDir(), "platform-sessions.json");
    this.browserProfilesDir = join(getPaprRoot(), "browser-profiles");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

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
  async connect(platformId: PlatformId): Promise<PlatformSessionState & { waitingForConfirmation?: boolean }> {
    if (!this.initialized) await this.initialize();

    const config = getPlatformConfig(platformId);
    if (!config) {
      return {
        platformId,
        status: "disconnected",
        error: `Unknown platform: ${platformId}`,
      };
    }

    if (this.connectingPlatform) {
      return {
        platformId,
        status: "disconnected",
        error: `Already connecting to ${this.connectingPlatform}. Please wait.`,
      };
    }

    this.connectingPlatform = platformId;
    console.log(`[PlatformSessionService] Starting connect flow for ${platformId}`);

    try {
      if (isChromeInstalled()) {
        return await this.connectViaChrome(platformId, config);
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
      const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
      if (!extracted.success) {
        throw new Error(
          extracted.missing.length > 0
            ? `Still missing cookies: ${extracted.missing.join(", ")}. Log in using Chrome, then try again.`
            : `No cookies found for ${config.name}. Log in using Chrome, then try again.`,
        );
      }

      await this.storeRequiredCookies(platformId, config, extracted.cookies);
      this.stopChromeCookiePolling(platformId);
      const state = await this.markConnected(platformId, config);
      console.log(`[PlatformSessionService] Successfully connected ${platformId} via manual check`);
      return state;
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

  private async connectViaChrome(
    platformId: PlatformId,
    config: PlatformConfig,
  ): Promise<PlatformSessionState & { waitingForConfirmation?: boolean }> {
    const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
    if (extracted.success) {
      await this.storeRequiredCookies(platformId, config, extracted.cookies);
      this.connectingPlatform = null;
      const state = await this.markConnected(platformId, config);
      console.log(`[PlatformSessionService] Connected ${platformId} using existing Chrome session`);
      return state;
    }

    await openInChrome(config.loginUrl);
    console.log(`[PlatformSessionService] Opened ${config.loginUrl} in Chrome`);
    this.startChromeCookiePolling(platformId, config);

    return {
      platformId,
      status: "connecting",
      waitingForConfirmation: true,
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
    if (isChromeInstalled()) {
      browserType = "chrome";
    }

    const userDataDir = join(profilePath, "browser-data");
    await fs.mkdir(userDataDir, { recursive: true });

    this.activeContext = await playwright.chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: browserType === "chrome" ? "chrome" : undefined,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      viewport: { width: 1280, height: 900 },
      ...(browserType === "chromium" && {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      }),
    });

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

  private startChromeCookiePolling(platformId: PlatformId, config: PlatformConfig): void {
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
        const extracted = await this.tryExtractRequiredCookiesFromChrome(config, {
          useCache: true,
        });
        if (!extracted.success) return;

        await this.storeRequiredCookies(platformId, config, extracted.cookies);
        this.stopChromeCookiePolling(platformId);
        this.connectingPlatform = null;
        const state = await this.markConnected(platformId, config);
        await this.broadcastStatusChange(state);
        console.log(`[PlatformSessionService] Auto-detected Chrome login for ${platformId}`);
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
    return this.store.sessions[platformId];
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
        await keysService.deleteKey(keyName);
      }

      await keysService.addKey({
        name: keyName,
        value: cookieValue,
        description: `${config.name} session cookie (auto-managed by Social Login)`,
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
      for (const cookieName of config.requiredCookies) {
        const keyName = getPlatformKeyName(platformId, cookieName);
        try {
          await keysService.deleteKey(keyName);
        } catch {
          // Key might not exist - that's fine
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
      if (isChromeInstalled()) {
        const extracted = await this.tryExtractRequiredCookiesFromChrome(config);
        if (extracted.success) {
          await this.storeRequiredCookies(platformId, config, extracted.cookies);
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
      this.activeBrowser = await playwright.chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      });

      this.activeContext = await this.activeBrowser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

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
      if (parsed.length > 0) return parsed;
    } catch {
      // Fall back to keychain
    }

    const keysService = getCustomKeysService();
    const cookies: Cookie[] = [];

    for (const cookieName of config.requiredCookies) {
      const keyName = getPlatformKeyName(platformId, cookieName);
      const value = await keysService.getKeyByName(keyName);
      if (!value) return [];

      cookies.push({
        name: cookieName,
        value,
        domain: config.cookieDomain,
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      });
    }

    return cookies;
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
          // Delete and re-add (no update method)
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
      this.activeBrowser = await playwright.chromium.launch({
        headless: false, // Visible browser for agent to see/interact
        args: ["--disable-blink-features=AutomationControlled"],
      });

      this.activeContext = await this.activeBrowser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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
