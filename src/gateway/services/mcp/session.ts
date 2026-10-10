/**
 * Claude's access token → Papr caller, via memory (PR 3).
 *
 *   POST {memory}/v1/cloud/mcp/session   Authorization: Bearer <Claude token>
 *                                        X-Papr-Service-Key: <host secret>
 *
 * Memory verifies the token, maps the Auth0 subject to the Papr user, provisions the
 * workspace on first sign-in, and returns a Papr session it minted for MCP. The session
 * stays on this server: Claude only ever holds its own Auth0 token.
 *
 * Results are cached per token (hashed) until the token or session expires, with
 * in-flight de-duplication so a burst of card calls makes one memory request.
 */
import { createHash } from "node:crypto";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { McpCaller } from "./auth.js";

export type McpSessionExchange = (token: string, tokenExpiresAt?: number) => Promise<McpCaller>;

export interface MemoryExchangeOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Re-ask memory at least this often even if the token lives longer. */
  maxCacheMs?: number;
  maxEntries?: number;
}

interface SessionBody {
  userId?: string;
  email?: string | null;
  displayName?: string | null;
  sessionToken?: string;
  sessionExpiresAt?: string;
  organizationId?: string;
  namespaceId?: string;
  workspaceId?: string | null;
  provisioned?: string[];
}

const SETUP_RETRIES = 2;

const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");

async function errorCode(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as { detail?: { code?: string; message?: string } };
    return { code: body.detail?.code ?? "", message: body.detail?.message ?? "" };
  } catch {
    return { code: "", message: "" };
  }
}

export function memorySessionExchange(baseUrl: string, serviceKey: string, opts: MemoryExchangeOptions = {}): McpSessionExchange {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxCacheMs = opts.maxCacheMs ?? 10 * 60_000;
  const maxEntries = opts.maxEntries ?? 5000;
  const url = `${baseUrl.replace(/\/$/, "")}/v1/cloud/mcp/session`;
  const cache = new Map<string, { until: number; caller: McpCaller }>();
  const inflight = new Map<string, Promise<McpCaller>>();

  async function call(token: string): Promise<{ caller: McpCaller; sessionExpiresMs: number }> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-papr-service-key": serviceKey, accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new ServerError("Papr is unreachable right now. Try again in a moment.");
      }
      if (res.ok) {
        const b = (await res.json()) as SessionBody;
        if (!b.sessionToken || !b.userId) throw new ServerError("Papr returned an incomplete session.");
        const caller: McpCaller = {
          sessionToken: b.sessionToken,
          userId: b.userId,
          email: b.email ?? undefined,
          displayName: b.displayName ?? undefined,
          subject: "",
          organizationId: b.organizationId,
          namespaceId: b.namespaceId,
          workspaceId: b.workspaceId ?? undefined,
          provisioned: b.provisioned ?? [],
        };
        const exp = b.sessionExpiresAt ? Date.parse(b.sessionExpiresAt) : NaN;
        return { caller, sessionExpiresMs: Number.isFinite(exp) ? exp : now() + maxCacheMs };
      }
      const { code, message } = await errorCode(res);
      if (res.status === 401 || code === "account_not_ready") {
        // 401 from the bearer middleware makes Claude re-run sign-in.
        throw new InvalidTokenError(message || "Your Papr sign-in expired. Reconnect Papr in Claude.");
      }
      if (code === "setup_in_progress" && attempt < SETUP_RETRIES) {
        const after = Number(res.headers.get("retry-after")) || 2;
        await sleep(Math.min(after, 3) * 1000);
        continue;
      }
      if (code === "setup_in_progress") throw new ServerError("Papr is still setting up your workspace. Try again in a moment.");
      if (code === "setup_deferred") throw new ServerError(message || "Papr couldn't check your workspace yet. Try again in a moment.");
      if (code === "mcp_not_configured" || code === "forbidden") {
        console.error(`[mcp] memory rejected the host (${code}). Check PAPR_MCP_SERVICE_KEY on both sides.`);
        throw new ServerError("Papr's Claude connection is misconfigured. We've been notified.");
      }
      throw new ServerError(message || `Papr sign-in failed (HTTP ${res.status}). Try again.`);
    }
  }

  return async (token, tokenExpiresAt) => {
    const key = hashToken(token);
    const hit = cache.get(key);
    if (hit && now() < hit.until) return hit.caller;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const { caller, sessionExpiresMs } = await call(token);
      const tokenMs = tokenExpiresAt ? tokenExpiresAt * 1000 : Infinity;
      const until = Math.min(tokenMs, sessionExpiresMs - 60_000, now() + maxCacheMs);
      if (until > now()) {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
        cache.set(key, { until, caller });
      }
      return caller;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
