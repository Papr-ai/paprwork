/**
 * Platform Session Service
 *
 * Manages browser profiles, cookie extraction, and session storage for social platforms.
 * Uses Playwright with persistent browser contexts for each platform.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
   * Connect to a platform - opens browser window for user to log in
   */
  async connect(platformId: PlatformId): Promise<PlatformSessionState> {
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
      // Launch browser with persistent profile (visible for user login)
      const profilePath = this.getProfilePath(platformId);
      await fs.mkdir(profilePath, { recursive: true });

      const playwright = await loadPlaywright();
      this.activeBrowser = await playwright.chromium.launch({
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
      });

      this.activeContext = await this.activeBrowser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });

      // Load existing cookies if any (for re-auth)
      const existingCookiesPath = join(profilePath, "cookies.json");
      try {
        const cookiesData = await fs.readFile(existingCookiesPath, "utf-8");
        const cookies = JSON.parse(cookiesData) as Cookie[];
        await this.activeContext.addCookies(cookies);
      } catch {
        // No existing cookies - fresh login
      }

      const page = await this.activeContext.newPage();
      await page.goto(config.loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      // Wait for user to complete login (poll for success URL)
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

      // Extract and store cookies
      await this.extractAndStoreCookies(platformId, config);

      // Save all cookies for persistent profile
      const allCookies = await this.activeContext.cookies();
      await fs.writeFile(existingCookiesPath, JSON.stringify(allCookies, null, 2));

      // Update state
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + config.sessionDurationDays * 24 * 60 * 60 * 1000,
      );

      this.store.sessions[platformId] = {
        platformId,
        status: "connected",
        connectedAt: now.toISOString(),
        lastRefreshedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await this.saveStore();

      console.log(`[PlatformSessionService] Successfully connected ${platformId}`);
      return this.store.sessions[platformId];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlatformSessionService] Connect failed for ${platformId}:`, errorMessage);

      return {
        platformId,
        status: "disconnected",
        error: errorMessage,
      };
    } finally {
      await this.closeBrowser();
      this.connectingPlatform = null;
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
      const profilePath = this.getProfilePath(platformId);
      const cookiesPath = join(profilePath, "cookies.json");

      // Load existing cookies
      let existingCookies: Cookie[] = [];
      try {
        const cookiesData = await fs.readFile(cookiesPath, "utf-8");
        existingCookies = JSON.parse(cookiesData) as Cookie[];
      } catch {
        throw new Error("No stored cookies found. Please reconnect.");
      }

      // Launch headless browser for refresh
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

      // Save updated cookies
      const allCookies = await this.activeContext.cookies();
      await fs.writeFile(cookiesPath, JSON.stringify(allCookies, null, 2));

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
    const profilePath = this.getProfilePath(platformId);
    const cookiesPath = join(profilePath, "cookies.json");

    let existingCookies: Cookie[] = [];
    try {
      const cookiesData = await fs.readFile(cookiesPath, "utf-8");
      existingCookies = JSON.parse(cookiesData) as Cookie[];
    } catch {
      return {
        success: false,
        message: `No stored session for ${config.name}. Use action="connect" first.`,
        error: "No stored cookies found",
      };
    }

    if (existingCookies.length === 0) {
      return {
        success: false,
        message: `No cookies found for ${config.name}. Use action="connect" first.`,
        error: "Empty cookie jar",
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
