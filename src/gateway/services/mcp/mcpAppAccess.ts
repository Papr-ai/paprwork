/**
 * Who is calling /api/mcp/* — and what they may do.
 *
 * Mini-apps are served from the gateway, so without this any app (including a
 * community app someone installed) could drive the user's Linear or Stripe.
 *
 * Callers:
 *   app   — request from a mini-app iframe (Host app-<id>.localhost, or Referer
 *           /apps/<id>/). May only touch services it declares in
 *           apps/<id>/connections.json, and only after the user approves that
 *           app × service once (persisted through the existing key-permission
 *           "always allow" store).
 *   ui    — browser request with no app identity: the desktop renderer. It
 *           manages connections but never calls tools, so /api/mcp/call is
 *           refused. That also covers an app that suppresses its Referer:
 *           Sec-Fetch-Site/Dest are forbidden headers a page cannot strip, so
 *           it still reads as a browser and still cannot call.
 *   local — non-browser process on loopback: jobs, the agent, curl. Trusted,
 *           like the rest of the local gateway.
 *   foreign — any non-loopback Origin. Refused outright.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";

import { resolveMiniAppIdFromRequest } from "../../utils/inferMiniAppIdFromRequest.js";
import { appIdFromHost } from "../../../core/miniApps/miniAppOrigin.js";

export type McpCaller =
  | { kind: "app"; appId: string }
  | { kind: "ui" }
  | { kind: "local" }
  | { kind: "forbidden"; reason: string };

export const APP_CONNECTIONS_FILENAME = "connections.json";

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      appIdFromHost(host) !== null
    );
  } catch {
    return false;
  }
}

export function resolveMcpCaller(headers: IncomingHttpHeaders): McpCaller {
  const origin = header(headers, "origin");
  if (origin && origin !== "null" && !isLoopbackOrigin(origin)) {
    return { kind: "forbidden", reason: "Cross-origin requests are not allowed" };
  }
  const resolved = resolveMiniAppIdFromRequest(undefined, headers);
  // 403 = Host and Referer name different apps. A 400 just means no app
  // identity at all ("appId is required"), which is the ui/local case below.
  if (resolved.status === 403) return { kind: "forbidden", reason: resolved.error ?? "Forbidden" };
  if (resolved.appId) return { kind: "app", appId: resolved.appId };
  // Opaque-origin (sandboxed without allow-same-origin) frames send Origin: null.
  if (origin === "null") {
    return { kind: "forbidden", reason: "Requests from sandboxed frames are not allowed" };
  }
  // Sec-Fetch-Site/Dest: Chromium always sends them and pages cannot strip
  // them. Node's fetch (undici) sends only Sec-Fetch-Mode, so a Node job still
  // reads as local.
  if (header(headers, "sec-fetch-site") || header(headers, "sec-fetch-dest")) {
    return { kind: "ui" };
  }
  return { kind: "local" };
}

export interface McpAppAccessOptions {
  /** Workspace root containing apps/<id>/. */
  paprRoot: () => string;
  /** Ask the user; resolves true when approved. */
  askUser: (input: { appId: string; appTitle: string; serverId: string; serverName: string }) => Promise<boolean>;
  appTitle: (appId: string) => Promise<string | undefined>;
}

/** Declared connections for an app: apps/<id>/connections.json → { connections: ["hubspot"] }. */
export async function readAppConnections(paprRoot: string, appId: string): Promise<string[]> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(paprRoot, "apps", appId, APP_CONNECTIONS_FILENAME), "utf8"),
    );
    const list = Array.isArray(raw) ? raw : raw?.connections;
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()))];
  } catch {
    return [];
  }
}

export class McpAccessError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "McpAccessError";
  }
}

/** Permission key shared with the desktop's "always allow" store. */
export function mcpAppGrantKey(appId: string, serverId: string): string {
  return `MCP_APP_GRANT:${appId}:${serverId}`;
}

export class McpAppAccess {
  /** Approvals this session (the persisted "always" lives in the main process). */
  private readonly sessionGrants = new Set<string>();
  /** One prompt at a time per app × server, however many calls race. */
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(private readonly opts: McpAppAccessOptions) {}

  declared(appId: string): Promise<string[]> {
    return readAppConnections(this.opts.paprRoot(), appId);
  }

  async assertDeclared(appId: string, serverId: string): Promise<void> {
    const declared = await this.declared(appId);
    if (!declared.includes(serverId)) {
      throw new McpAccessError(
        `This app has not declared the "${serverId}" connection. Add it to apps/${appId}/${APP_CONNECTIONS_FILENAME}: {"connections": [${[...declared, serverId].map((s) => `"${s}"`).join(", ")}]}`,
        403,
      );
    }
  }

  /** Declared AND approved by the user for this app. Prompts once if needed. */
  async assertGranted(appId: string, serverId: string, serverName: string): Promise<void> {
    await this.assertDeclared(appId, serverId);
    const key = mcpAppGrantKey(appId, serverId);
    if (this.sessionGrants.has(key)) return;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const appTitle = (await this.opts.appTitle(appId).catch(() => undefined)) || "This app";
        return this.opts.askUser({ appId, appTitle, serverId, serverName }).catch(() => false);
      })();
      this.inflight.set(key, pending);
      void pending.finally(() => this.inflight.delete(key));
    }
    if (!(await pending)) {
      throw new McpAccessError(`Access to ${serverName} was not approved for this app.`, 403);
    }
    this.sessionGrants.add(key);
  }

  revokeServer(serverId: string): void {
    for (const k of this.sessionGrants) if (k.endsWith(`:${serverId}`)) this.sessionGrants.delete(k);
  }
}
