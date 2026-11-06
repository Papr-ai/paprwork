/**
 * Session Keeper Service
 *
 * Background loop that automatically refreshes platform sessions before they expire.
 * Runs as part of Gateway startup (like JobsScheduler).
 */

import {
  type PlatformId,
  getPlatformConfig,
} from "./platformRegistry.js";
import {
  getPlatformSessionService,
  type PlatformSessionState,
} from "./PlatformSessionService.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const MIN_REFRESH_DELAY_MS = 30 * 1000; // Minimum 30 seconds between refreshes
/** Sites that do not rotate tokens stay signed in on their own; re-checking often only risks false logouts. */
const STABLE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often to look for a sign-in that happened in Papr Chrome for sites marked needs_reauth. */
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

interface RefreshState {
  lastAttemptAt: number;
  consecutiveFailures: number;
}

/**
 * Session Keeper Service - Singleton
 */
export class SessionKeeperService {
  private running = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private refreshState: Map<PlatformId, RefreshState> = new Map();

  /**
   * Start the session keeper background loop
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log("[SessionKeeperService] Starting background session keeper");

    // Initial check after a short delay (let services initialize)
    setTimeout(() => {
      void this.checkAllPlatforms();
    }, 5000);

    // Regular check interval
    this.checkInterval = setInterval(() => {
      void this.checkAllPlatforms();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop the session keeper
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    console.log("[SessionKeeperService] Stopped");
  }

  /**
   * Check all connected platforms and refresh if needed
   */
  private async checkAllPlatforms(): Promise<void> {
    if (!this.running) return;

    const sessionService = getPlatformSessionService();
    const statuses = await sessionService.getAllStatuses();

    for (const status of statuses) {
      if (!this.running) break;

      if (status.status === "connected") {
        await this.checkAndRefreshIfNeeded(status);
      } else if (status.status === "needs_reauth") {
        await this.tryRecover(status.platformId);
      }
    }
  }

  /** Cheap local check: if the user signed in again in Papr Chrome, flip back to connected. */
  private async tryRecover(platformId: PlatformId): Promise<void> {
    const state = this.refreshState.get(platformId) ?? { lastAttemptAt: 0, consecutiveFailures: 0 };
    const now = Date.now();
    if (now - state.lastAttemptAt < RECOVERY_INTERVAL_MS) return;
    state.lastAttemptAt = now;
    this.refreshState.set(platformId, state);
    try {
      const recovered = await getPlatformSessionService().syncFromLivePaprChrome(platformId);
      if (recovered) console.log(`[SessionKeeperService] Recovered ${platformId} from Papr Chrome`);
    } catch (error) {
      console.warn(`[SessionKeeperService] Recovery check failed for ${platformId}:`, error);
    }
  }

  /**
   * Check if a platform needs refresh and trigger it if so
   */
  private async checkAndRefreshIfNeeded(
    status: PlatformSessionState,
  ): Promise<void> {
    const platformId = status.platformId;
    const config = getPlatformConfig(platformId);
    if (!config) return;

    // Check rate limiting
    const state = this.refreshState.get(platformId) ?? {
      lastAttemptAt: 0,
      consecutiveFailures: 0,
    };

    const now = Date.now();
    const timeSinceLastAttempt = now - state.lastAttemptAt;

    // Backoff on consecutive failures (exponential: 1min, 2min, 4min, 8min, max 30min)
    const backoffMs = Math.min(
      MIN_REFRESH_DELAY_MS * Math.pow(2, state.consecutiveFailures),
      30 * 60 * 1000,
    );

    if (timeSinceLastAttempt < backoffMs) {
      return; // Too soon after last attempt
    }

    // Check if refresh is needed
    const lastRefreshed = status.lastRefreshedAt
      ? new Date(status.lastRefreshedAt).getTime()
      : 0;
    const timeSinceRefresh = now - lastRefreshed;

    const intervalMs = config.rotatesTokens
      ? config.refreshIntervalMs
      : Math.max(config.refreshIntervalMs, STABLE_REFRESH_INTERVAL_MS);
    if (timeSinceRefresh < intervalMs) {
      return; // Not yet due for refresh
    }

    // Trigger refresh
    console.log(
      `[SessionKeeperService] Refreshing ${platformId} (last refresh: ${Math.round(timeSinceRefresh / 1000 / 60)}min ago)`,
    );

    state.lastAttemptAt = now;
    this.refreshState.set(platformId, state);

    try {
      const sessionService = getPlatformSessionService();
      const result = await sessionService.refresh(platformId);

      if (result.status === "connected" && !result.error) {
        // Success - reset failure count
        state.consecutiveFailures = 0;
        this.refreshState.set(platformId, state);
        console.log(`[SessionKeeperService] Successfully refreshed ${platformId}`);
      } else {
        // Failure
        state.consecutiveFailures++;
        this.refreshState.set(platformId, state);
        console.warn(
          `[SessionKeeperService] Refresh failed for ${platformId}: ${result.error}`,
        );
      }
    } catch (error) {
      state.consecutiveFailures++;
      this.refreshState.set(platformId, state);
      console.error(`[SessionKeeperService] Refresh error for ${platformId}:`, error);
    }
  }

  /**
   * Force refresh a specific platform (manual trigger)
   */
  async forceRefresh(platformId: PlatformId): Promise<PlatformSessionState> {
    console.log(`[SessionKeeperService] Force refreshing ${platformId}`);

    // Reset backoff state
    this.refreshState.delete(platformId);

    const sessionService = getPlatformSessionService();
    return sessionService.refresh(platformId);
  }
}

// Singleton instance
let sessionKeeperServiceInstance: SessionKeeperService | null = null;

/**
 * Get or create SessionKeeperService singleton
 */
export function getSessionKeeperService(): SessionKeeperService {
  if (!sessionKeeperServiceInstance) {
    sessionKeeperServiceInstance = new SessionKeeperService();
  }
  return sessionKeeperServiceInstance;
}
