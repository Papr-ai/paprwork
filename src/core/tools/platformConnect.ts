/**
 * Platform Connect Tool
 *
 * Agent tool for Platform Connections (built-in social sites + registered login sites).
 * Wraps PlatformSessionService - delegates browser/cookie handling to the service.
 *
 * SECURITY: Never returns raw cookie values. Jobs access cookies via ${KEY_NAME} substitution.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolResult } from "../types/index.js";
import { getPlaywrightCookieDomain } from "../../gateway/services/platforms/platformCookieUtils.js";
import type { PlatformId } from "../../gateway/services/platforms/platformRegistry.js";

export const connectPlatformTool = createTool({
  id: "connect_platform",
  description: `Check status or manage Platform Connections (built-in social sites + user/agent-registered login sites).

Use this to:
- Register a login-required site: action="register" with url — then request_connect
- Check if connected: action="status"
- **Automate with agent browser tools: action="prepare_browser"** (desktop: real Chrome window outside Papr when installed; embedded tab fallback)
- Ask user to connect: action="request_connect"
- Remove a custom site: action="unregister"
- Open a visible window for the user: action="browse" (NOT for agent automation)

Built-in: linkedin, instagram, reddit, facebook, tiktok, twitter, telegram
Custom sites get ids like site-notion-so — register first, then prepare_browser.

IMPORTANT:
- **LinkedIn:** user must sign in in Papr-managed Chrome (never import from personal Chrome)
- **Other platforms:** may connect instantly if already logged into personal Chrome; otherwise Papr Chrome opens for sign-in
- **Connected = keychain cookies** (LINKEDIN_LI_AT, REDDIT_REDDIT_SESSION, TWITTER_AUTH_TOKEN, …) — usable in jobs and cloud when pushed to **cloud vault** (desktop awake + Cloud Sync on)
- **Job automation split:**
  - **LinkedIn jobs:** Python → requirements: ["linkedin-api", "playwright"] + papr_platform_browser (CDP to Papr Chrome :9222). Agent → prepare_browser + browser_*
  - **X, Reddit, Instagram, … jobs:** Python/bash → \${PLATFORM_*} cookie keys + headless Playwright / requests / curl. Do NOT use reddit-api/x-api CDP. Papr Chrome is sign-in only, not job runtime. Cloud: vault keys + headless Playwright.
- **Agent/subagent jobs + chat:** prepare_browser → browser_* (headless with keychain cookies in cloud; real Chrome on desktop when installed)
- **API discovery:** after prepare_browser use browser_network_logs + browser_console_logs
- Prefer browser_* over bash/curl for LinkedIn (tip appended if curl used). For Reddit/X scraper jobs, prefer \${KEY} + headless Playwright over browser_*.`,
  inputSchema: z
    .object({
      platform: z
        .string()
        .optional()
        .describe("Platform id (built-in or registered custom site, e.g. site-notion-so)"),
      action: z
        .enum([
          "status",
          "connect",
          "disconnect",
          "refresh",
          "get_cookies",
          "browse",
          "prepare_browser",
          "get_rate_limits",
          "request_connect",
          "register",
          "unregister",
        ])
        .default("status"),
      reason: z
        .string()
        .optional()
        .describe("For request_connect: shown to user in connect modal"),
      url: z
        .string()
        .optional()
        .describe("For register: site URL. For prepare_browser: optional start URL"),
      name: z
        .string()
        .optional()
        .describe("For register: display name (defaults to hostname)"),
    })
    .superRefine((value, ctx) => {
      if (value.action === "register") {
        if (!value.url?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "url is required for register",
            path: ["url"],
          });
        }
        return;
      }
      if (!value.platform?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "platform is required for this action",
          path: ["platform"],
        });
      }
    }),

  execute: async (inputData): Promise<ToolResult> => {
    const args = (inputData as { context?: typeof inputData }).context || inputData;
    const { platform, action, reason, url, name } = args as {
      platform?: string;
      action: string;
      reason?: string;
      url?: string;
      name?: string;
    };
    const startTime = performance.now();

    try {
      if (action === "register") {
        const { registerCustomPlatformConnection } = await import(
          "../../gateway/services/platforms/customPlatformConnections.js"
        );
        const { refreshCustomPlatformConfigCache } = await import(
          "../../gateway/services/platforms/platformRegistry.js"
        );

        const record = await registerCustomPlatformConnection({
          url: url ?? "",
          name,
          registeredBy: "agent",
        });
        await refreshCustomPlatformConfigCache();

        return {
          success: true,
          data: {
            platformId: record.id,
            name: record.name,
            homeUrl: record.homeUrl,
            message:
              `Registered ${record.name} as Platform Connection "${record.id}". ` +
              `Use request_connect so the user can log in, then prepare_browser.`,
            nextSteps: [
              `connect_platform({ platform: "${record.id}", action: "request_connect", reason: "..." })`,
              `connect_platform({ platform: "${record.id}", action: "prepare_browser" })`,
            ],
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      if (action === "unregister") {
        const platformId = platform ?? "";
        const { unregisterCustomPlatformConnection } = await import(
          "../../gateway/services/platforms/customPlatformConnections.js"
        );
        const { refreshCustomPlatformConfigCache, getPlatformConfig } = await import(
          "../../gateway/services/platforms/platformRegistry.js"
        );
        const config = getPlatformConfig(platformId);
        if (!config?.isCustom) {
          return {
            success: false,
            data: {
              platformId,
              message: "Only custom Platform Connections can be unregistered.",
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        const { getPlatformSessionService } = await import(
          "../../gateway/services/platforms/PlatformSessionService.js"
        );
        const sessionService = getPlatformSessionService();
        await sessionService.initialize();
        await sessionService.disconnect(platformId);
        await unregisterCustomPlatformConnection(platformId);
        await refreshCustomPlatformConfigCache();

        return {
          success: true,
          data: {
            platformId,
            message: `Removed Platform Connection ${config.name}.`,
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      const platformId = platform ?? "";
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

      const config = getPlatformConfig(platformId);
      if (!config) {
        return {
          success: false,
          data: {
            platform: platformId,
            action,
            message:
              `Unknown platform "${platformId}". Use action="register" with url for custom sites.`,
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      switch (action) {
        case "status": {
          const status = await sessionService.getStatus(platformId);
          const keyNames = getAllPlatformKeyNames(platformId);
          const r = config.rateLimits;

          return {
            success: true,
            data: {
              platform: config.name,
              platformId,
              status: status.status,
              connectedAt: status.connectedAt,
              lastRefreshedAt: status.lastRefreshedAt,
              expiresAt: status.expiresAt,
              error: status.error,
              isCustom: config.isCustom,
              keyNames,
              usage:
                status.status === "connected"
                  ? config.isCustom
                    ? `Job keys use prefix ${config.keyPrefix}_ — list keys in Settings`
                    : `Use \${${keyNames[0]}} in job commands`
                  : `Not connected. Use request_connect or Settings → Platform Connections`,
              rateLimits: {
                dailyViews: r.dailyViews,
                dailyMessages: r.dailyMessages,
                dailyConnections: r.dailyConnections,
                dailyPosts: r.dailyPosts,
                hourlyActions: r.hourlyActions,
                actionDelay: `${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s`,
              },
              rateLimitWarning: `Stay within ${r.dailyViews} views/day. Wait ${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s between actions. ${r.notes}`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "connect": {
          const currentStatus = await sessionService.getStatus(platformId);
          if (currentStatus.status === "connected") {
            return {
              success: true,
              data: {
                platform: config.name,
                platformId,
                status: "already_connected",
                message: `${config.name} is already connected. Use refresh or disconnect.`,
                expiresAt: currentStatus.expiresAt,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          return {
            success: true,
            data: {
              platform: config.name,
              platformId,
              status: "awaiting_user_action",
              message: `Ask the user to open Settings → Platform Connections and click Connect for ${config.name}.`,
              settingsPath: "Settings → Platform Connections",
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "disconnect": {
          const result = await sessionService.disconnect(platformId);
          return {
            success: true,
            data: {
              platform: config.name,
              platformId,
              status: result.status,
              message:
                result.status === "disconnected"
                  ? `${config.name} disconnected.`
                  : `Failed to disconnect: ${result.error}`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "refresh": {
          const currentStatus = await sessionService.getStatus(platformId);
          if (currentStatus.status !== "connected" && currentStatus.status !== "needs_reauth") {
            return {
              success: false,
              data: {
                platform: config.name,
                platformId,
                status: currentStatus.status,
                message: `${config.name} is not connected.`,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const sessionKeeper = getSessionKeeperService();
          const result = await sessionKeeper.forceRefresh(platformId);

          return {
            success: result.status === "connected",
            data: {
              platform: config.name,
              platformId,
              status: result.status,
              lastRefreshedAt: result.lastRefreshedAt,
              message:
                result.status === "connected"
                  ? `${config.name} session refreshed.`
                  : `Refresh failed: ${result.error}`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "get_cookies": {
          if (platformId === "linkedin") {
            return {
              success: false,
              data: {
                platform: config.name,
                platformId,
                message:
                  "Do not export LinkedIn cookies for HTTP/curl replay — PerimeterX will invalidate the session. " +
                  "Use connect_platform action=\"prepare_browser\" then browser_navigate / browser_snapshot / browser_test_script.",
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

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

          if (config.isCustom) {
            const prefix = `${config.keyPrefix}_`;
            const keys = await keysService.listKeys();
            for (const key of keys) {
              if (!key.name.startsWith(prefix)) continue;
              const cookieName = key.name.slice(prefix.length);
              try {
                const value = await keysService.getKeyByName(key.name);
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
                /* skip missing key */
              }
            }
          } else {
            for (const cookieName of config.requiredCookies) {
              const keyName = `${config.keyPrefix}_${cookieName.toUpperCase()}`;
              try {
                const value = await keysService.getKeyByName(keyName);
                if (value) {
                  cookies.push({
                    name: cookieName,
                    value,
                    domain: getPlaywrightCookieDomain(config, cookieName),
                    path: "/",
                    secure: true,
                    httpOnly: true,
                  });
                }
              } catch {
                /* Key not found */
              }
            }
          }

          if (cookies.length === 0) {
            return {
              success: false,
              data: {
                platform: config.name,
                platformId,
                message: `No cookies found. Connect via Platform Connections first.`,
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
              platformId,
              cookies,
              message: `Retrieved ${cookies.length} cookies for ${config.name}.`,
              rateLimits: {
                dailyViews: r.dailyViews,
                dailyMessages: r.dailyMessages,
                dailyConnections: r.dailyConnections,
                dailyPosts: r.dailyPosts,
                hourlyActions: r.hourlyActions,
                actionDelay: `${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s`,
              },
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "prepare_browser": {
          const currentStatus = await sessionService.getStatus(platformId);
          if (currentStatus.status !== "connected") {
            return {
              success: false,
              data: {
                platform: config.name,
                platformId,
                status: currentStatus.status,
                message: `${config.name} is not connected. Use request_connect first.`,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const { preparePlatformBrowserSession } = await import("./browser.js");
          const result = await preparePlatformBrowserSession(platformId, url);
          const r = config.rateLimits;

          return {
            success: result.success,
            data: {
              platform: config.name,
              platformId,
              url: result.url,
              title: result.title,
              message: result.message,
              error: result.error,
              browserMode: result.browserMode,
              doNotUse:
                result.success
                  ? result.browserMode === "real_chrome"
                    ? "Automation runs in the real Chrome window outside Papr — use browser_* tools, not bash/curl."
                    : "Prefer browser_* on this tab over bash/curl cookie replay (often empty CSRF/Voyager results)."
                  : undefined,
              nextSteps: result.success
                ? [
                    "browser_snapshot — read page HTML (how you see the UI)",
                    "browser_network_logs({ limit: 100 }) — network tab (xhr/fetch URLs, status)",
                    "browser_console_logs({ limit: 50 }) — JS errors",
                    "browser_navigate — go to other URLs (auto settle wait after each navigation)",
                    "browser_click / browser_type — interact via CSS selectors from snapshot",
                    "page_wait_for({ target: 'browser', time: 3 }) — extra wait if SPA still loading",
                    "browser_test_script — extract structured data",
                  ]
                : [
                    "Try connect_platform action=\"refresh\" first",
                    "If Settings shows Connected, retry prepare_browser",
                  ],
              rateLimits: result.success
                ? {
                    dailyViews: r.dailyViews,
                    dailyMessages: r.dailyMessages,
                    dailyConnections: r.dailyConnections,
                    dailyPosts: r.dailyPosts,
                    hourlyActions: r.hourlyActions,
                    actionDelay: `${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s`,
                  }
                : undefined,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "browse": {
          const result = await sessionService.openAuthenticatedBrowser(platformId, url);
          const r = config.rateLimits;

          return {
            success: result.success,
            data: {
              platform: config.name,
              platformId,
              message: result.message,
              error: result.error,
              hint: "For agent automation use prepare_browser instead.",
              rateLimits: result.success
                ? {
                    dailyViews: r.dailyViews,
                    dailyMessages: r.dailyMessages,
                    dailyConnections: r.dailyConnections,
                    dailyPosts: r.dailyPosts,
                    hourlyActions: r.hourlyActions,
                    actionDelay: `${r.minActionDelayMs / 1000}-${r.maxActionDelayMs / 1000}s`,
                  }
                : undefined,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "get_rate_limits": {
          const rateLimits = config.rateLimits;
          return {
            success: true,
            data: {
              platform: config.name,
              platformId,
              rateLimits,
              message: `Rate limits for ${config.name}: ${rateLimits.dailyViews} views/day.`,
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }

        case "request_connect": {
          const currentStatus = await sessionService.getStatus(platformId);
          if (currentStatus.status === "connected") {
            return {
              success: true,
              data: {
                platform: config.name,
                platformId,
                status: "already_connected",
                message: `${config.name} is already connected. Use prepare_browser.`,
              },
              duration: performance.now() - startTime,
              timestamp: new Date().toISOString(),
            };
          }

          const { broadcast } = await import("../../gateway/websocket/index.js");
          const requestId = crypto.randomUUID();

          broadcast({
            type: "platform:connect-request",
            data: {
              platformId,
              reason: reason || `To access your ${config.name} account`,
              requestId,
            },
          });

          return {
            success: true,
            data: {
              platform: config.name,
              platformId,
              requestId,
              message: `Connection request sent. User will see a Connect modal for ${config.name}.`,
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
