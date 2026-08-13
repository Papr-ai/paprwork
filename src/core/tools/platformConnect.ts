/**
 * Platform Connect Tool
 *
 * Agent tool for checking status or triggering connections to social platforms.
 * Wraps PlatformSessionService - delegates actual browser/cookie handling to the service.
 *
 * SECURITY: Never returns raw cookie values. Jobs access cookies via ${KEY_NAME} substitution.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolResult } from "../types/index.js";

const PLATFORM_IDS = [
  // Social
  "linkedin",
  "instagram",
  "reddit",
  "facebook",
  "tiktok",
  "twitter",
] as const;

type PlatformId = (typeof PLATFORM_IDS)[number];

export const connectPlatformTool = createTool({
  id: "connect_platform",
  description: `Check status or manage connections for social platforms (LinkedIn, Instagram, Reddit, Facebook, TikTok, Twitter).

Use this to:
- Check if a platform is connected: action="status"
- Trigger a connection flow (opens browser for user login): action="connect"
- Disconnect a platform (removes stored cookies): action="disconnect"
- Force refresh a session: action="refresh"

IMPORTANT:
- The "connect" action opens a browser window where the user must log in manually
- Cookies are stored securely in the keychain as integration keys (e.g., LINKEDIN_LI_AT)
- Jobs can access these via \${LINKEDIN_LI_AT} substitution
- Sessions refresh automatically in the background
- For X/Twitter, the "bird" CLI tool is often easier (auto-reads browser cookies)`,

  inputSchema: z.object({
    platform: z
      .enum(PLATFORM_IDS)
      .describe("The social platform to connect to"),
    action: z
      .enum(["status", "connect", "disconnect", "refresh", "get_cookies", "browse", "get_rate_limits", "request_connect"])
      .default("status")
      .describe(
        "Action to perform: status (check connection), connect (open login directly), disconnect (remove), refresh (force session refresh), get_cookies (get cookies for CDP injection), browse (open authenticated browser window), get_rate_limits (get safe automation limits), request_connect (show branded modal to user - PREFERRED for asking user to connect)",
      ),
    reason: z
      .string()
      .optional()
      .describe("For request_connect: explain why you need this platform connected (shown to user in modal)"),
  }),

  execute: async (inputData): Promise<ToolResult> => {
    const args = (inputData as { context?: typeof inputData }).context || inputData;
    const { platform, action, reason } = args as { platform: PlatformId; action: string; reason?: string };
    const startTime = performance.now();

    try {
      // Import the service (lazy to avoid circular deps)
      const { getPlatformSessionService } = await import(
        "../../gateway/services/platforms/PlatformSessionService.js"
      );
      const { getSessionKeeperService } = await import(
        "../../gateway/services/platforms/SessionKeeperService.js"
      );
      const { getPlatformConfig, getAllPlatformKeyNames } = await import(
        "../../gateway/services/platforms/platformRegistry.js"
      );

      const sessionService = getPlatformSessionService();
      await sessionService.initialize();

      const config = getPlatformConfig(platform);
      if (!config) {
        throw new Error(`Unknown platform: ${platform}`);
      }

      switch (action) {
        case "status": {
          const status = await sessionService.getStatus(platform);
          const keyNames = getAllPlatformKeyNames(platform);
          const r = config.rateLimits;

          return {
            success: true,
            data: {
              platform: config.name,
              platformId: platform,
              status: status.status,
              connectedAt: status.connectedAt,
              lastRefreshedAt: status.lastRefreshedAt,
              expiresAt: status.expiresAt,
              error: status.error,
              keyNames,
              usage:
                status.status === "connected"
                  ? `Use \${${keyNames[0]}} in job commands to reference the session cookie`
                  : `Not connected. Use action="connect" or direct user to Settings → Platforms`,
              // Always include rate limits so agent knows the safe limits
              rateLimits: {
                dailyViews: r.dailyViews,
                dailyMessages: r.dailyMessages,
                dailyConnections: r.dailyConnections,
                dailyPosts: r.dailyPosts,
                hourlyActions: r.hourlyActions,
                actionDelay: `${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s`,
              },
              rateLimitWarning: `IMPORTANT: Stay within ${r.dailyViews} views, ${r.dailyMessages} messages, ${r.dailyConnections} connections per day. Wait ${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s between actions. ${r.notes}`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "connect": {
          // Check current status first
          const currentStatus = await sessionService.getStatus(platform);
          if (currentStatus.status === "connected") {
            return {
              success: true,
              data: {
                platform: config.name,
                platformId: platform,
                status: "already_connected",
                message: `${config.name} is already connected. Use action="refresh" to refresh the session or action="disconnect" to remove it.`,
                expiresAt: currentStatus.expiresAt,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          // Note: This opens a browser and blocks until user logs in or timeout
          // We inform the user what's happening
          // Note: The tool returns immediately with instructions
          // The actual browser connection happens asynchronously via UI
          // To trigger connect programmatically, call sessionService.connect() directly
          return {
            success: true,
            data: {
              platform: config.name,
              platformId: platform,
              status: "awaiting_user_action",
              message: `To connect ${config.name}, the user should go to Settings → Platforms and click Connect. This opens a browser window where they can log in normally (2FA supported). Session cookies will be captured automatically and stored securely.`,
              instructions: [
                "1. Direct user to Settings → Platforms",
                "2. Click Connect on the platform card",
                `3. A ${config.name} login page will open in a browser window`,
                "4. User logs in with their account (2FA is supported)",
                "5. Once logged in, cookies are captured automatically",
                "6. The connection status will update to 'connected'",
              ],
              settingsPath: "Settings → Platforms",
              alternative: "User can also use shell.openExternal to open the settings if needed",
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "disconnect": {
          const result = await sessionService.disconnect(platform);
          return {
            success: true,
            data: {
              platform: config.name,
              platformId: platform,
              status: result.status,
              message:
                result.status === "disconnected"
                  ? `${config.name} has been disconnected. Session cookies removed from keychain.`
                  : `Failed to disconnect: ${result.error}`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "refresh": {
          const currentStatus = await sessionService.getStatus(platform);
          if (currentStatus.status !== "connected" && currentStatus.status !== "needs_reauth") {
            return {
              success: false,
              data: {
                platform: config.name,
                platformId: platform,
                status: currentStatus.status,
                message: `Cannot refresh - ${config.name} is not connected. Use action="connect" first.`,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const sessionKeeper = getSessionKeeperService();
          const result = await sessionKeeper.forceRefresh(platform);

          return {
            success: result.status === "connected",
            data: {
              platform: config.name,
              platformId: platform,
              status: result.status,
              lastRefreshedAt: result.lastRefreshedAt,
              message:
                result.status === "connected"
                  ? `${config.name} session refreshed successfully.`
                  : `Refresh failed: ${result.error}. User may need to reconnect via Settings → Platforms.`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "get_cookies": {
          // Get cookie values and return in CDP-compatible format for browser injection
          const { getCustomKeysService } = await import(
            "../../gateway/services/CustomKeysService.js"
          );
          const keysService = getCustomKeysService();
          
          const cookies: Array<{
            name: string;
            value: string;
            domain: string;
            path: string;
            secure: boolean;
            httpOnly: boolean;
          }> = [];
          
          for (const cookieName of config.requiredCookies) {
            const keyName = `${config.keyPrefix}_${cookieName.toUpperCase()}`;
            try {
              const value = await keysService.getKeyByName(keyName);
              if (value) {
                cookies.push({
                  name: cookieName,
                  value,
                  domain: config.cookieDomain,
                  path: "/",
                  secure: true,
                  httpOnly: true,
                });
              }
            } catch {
              // Key not found
            }
          }
          
          if (cookies.length === 0) {
            return {
              success: false,
              data: {
                platform: config.name,
                platformId: platform,
                message: `No cookies found for ${config.name}. Use action="connect" first or check Settings → Platforms.`,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }
          
          const r = config.rateLimits;
          return {
            success: true,
            data: {
              platform: config.name,
              platformId: platform,
              cookies,
              cdpUsage: `Use browser_cdp with method "Network.setCookies" and params: { cookies: ${JSON.stringify(cookies)} }`,
              message: `Retrieved ${cookies.length} cookies for ${config.name}. Inject into browser using CDP Network.setCookies.`,
              // Always include rate limits when providing cookies for automation
              rateLimits: {
                dailyViews: r.dailyViews,
                dailyMessages: r.dailyMessages,
                dailyConnections: r.dailyConnections,
                dailyPosts: r.dailyPosts,
                hourlyActions: r.hourlyActions,
                actionDelay: `${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s`,
              },
              rateLimitWarning: `⚠️ RATE LIMITS: Max ${r.dailyViews} views, ${r.dailyMessages} messages, ${r.dailyConnections} connections/day. Wait ${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s between actions. ${r.notes}`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "browse": {
          // Open a visible authenticated browser using the stored session
          const result = await sessionService.openAuthenticatedBrowser(platform);
          const r = config.rateLimits;
          
          return {
            success: result.success,
            data: {
              platform: config.name,
              platformId: platform,
              message: result.message,
              error: result.error,
              hint: result.success
                ? "Browser window is now open and authenticated. The user can interact with it directly, or you can describe what you see and guide them."
                : undefined,
              // Always include rate limits when browsing
              rateLimits: result.success ? {
                dailyViews: r.dailyViews,
                dailyMessages: r.dailyMessages,
                dailyConnections: r.dailyConnections,
                dailyPosts: r.dailyPosts,
                hourlyActions: r.hourlyActions,
                actionDelay: `${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s`,
              } : undefined,
              rateLimitWarning: result.success
                ? `⚠️ RATE LIMITS: Max ${r.dailyViews} views, ${r.dailyMessages} messages, ${r.dailyConnections} connections/day. Wait ${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s between actions. ${r.notes}`
                : undefined,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "get_rate_limits": {
          // Return rate limits for safe automation
          const rateLimits = config.rateLimits;
          
          return {
            success: true,
            data: {
              platform: config.name,
              platformId: platform,
              rateLimits: {
                dailyViews: rateLimits.dailyViews,
                dailyMessages: rateLimits.dailyMessages,
                dailyConnections: rateLimits.dailyConnections,
                dailyPosts: rateLimits.dailyPosts,
                hourlyActions: rateLimits.hourlyActions,
                minActionDelayMs: rateLimits.minActionDelayMs,
                maxActionDelayMs: rateLimits.maxActionDelayMs,
              },
              notes: rateLimits.notes,
              message: `Rate limits for ${config.name}: ${rateLimits.dailyViews} views/day, ${rateLimits.dailyMessages} messages/day, ${rateLimits.dailyConnections} connections/day. Delay ${rateLimits.minActionDelayMs / 1000}-${rateLimits.maxActionDelayMs / 1000}s between actions. These are safe defaults - override only if the use case warrants it and inform the user of risks.`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "request_connect": {
          // Show branded modal to user requesting connection
          // This broadcasts to the UI which shows the PlatformConnectModal
          const { broadcast } = await import(
            "../../gateway/websocket/index.js"
          );
          
          const requestId = crypto.randomUUID();
          
          broadcast({
            type: "platform:connect-request",
            data: {
              platformId: platform,
              reason: reason || `To access your ${config.name} account`,
              requestId,
            },
          });
          
          return {
            success: true,
            data: {
              platform: config.name,
              platformId: platform,
              requestId,
              message: `Connection request sent to user. A branded modal is now showing asking them to connect ${config.name}. Wait for them to complete the login flow.`,
              hint: "The user will see a modal with a 'Connect' button. Once they log in, you can use other actions like 'browse' or 'get_cookies' to interact with their account.",
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[connect_platform] Error:`, errorMessage);

      return {
        success: false,
        data: {
          platform,
          action,
          error: errorMessage,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  },
});

/**
 * Programmatically trigger a platform connect flow
 * Can be called directly if needed for automation
 */
export async function handleConnectTrigger(
  platform: string,
): Promise<{ status: string; error?: string }> {
  try {
    const { getPlatformSessionService } = await import(
      "../../gateway/services/platforms/PlatformSessionService.js"
    );
    const sessionService = getPlatformSessionService();
    await sessionService.initialize();
    const result = await sessionService.connect(platform as PlatformId);
    return { status: result.status, error: result.error };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
