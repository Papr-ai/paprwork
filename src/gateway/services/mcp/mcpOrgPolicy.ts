/**
 * Org connection rules + member requests, proxied to the memory server
 * (/v1/cloud/connections/*). Settings UI talks to /api/mcp/org/* so it never
 * handles the Papr API key; connect() checks the cached policy so an
 * unapproved service can't be connected by calling the route directly.
 *
 * Offline / logged out / server not deployed → no policy (everything allowed),
 * matching how vault sync treats a missing policy.
 */
import type { Express, Request, Response } from "express";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";

export type ConnectMode = "all" | "approved" | "none";

export interface OrgConnectionPolicy {
  mode: ConnectMode;
  approved: string[];
  maxShare: "user" | "members" | "namespace" | "org";
  maxPenAccess: "read" | "ask" | "full";
  setupBy: "admins" | "anyone";
}

const TTL_MS = 60_000;
let cache: { at: number; policy: OrgConnectionPolicy | null; isAdmin: boolean } | null = null;

export function clearOrgPolicyCache(): void {
  cache = null;
}

export async function getOrgPolicy(force = false): Promise<{ policy: OrgConnectionPolicy | null; isAdmin: boolean }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const res = await cloudApiFetch("/v1/cloud/connections/policy", { timeoutMs: 10_000 });
    if (!res.ok) throw new Error(`policy ${res.status}`);
    const body = (await res.json()) as { policy: OrgConnectionPolicy; isAdmin?: boolean };
    cache = { at: Date.now(), policy: body.policy, isAdmin: Boolean(body.isAdmin) };
  } catch {
    // Keep the last known policy when the server is briefly unreachable.
    cache = { at: Date.now(), policy: cache?.policy ?? null, isAdmin: cache?.isAdmin ?? false };
  }
  return cache;
}

export function canConnect(policy: OrgConnectionPolicy | null, serverId: string): boolean {
  if (!policy || policy.mode === "all") return true;
  if (policy.mode === "none") return false;
  return policy.approved.includes(serverId.toLowerCase());
}

export class OrgPolicyBlockedError extends Error {
  readonly status = 403;
  constructor(name: string) {
    super(`Your organization hasn't approved ${name} yet. Request it in Settings → Connections.`);
  }
}

export async function assertOrgAllows(serverId: string, name: string): Promise<void> {
  const { policy } = await getOrgPolicy();
  if (!canConnect(policy, serverId)) throw new OrgPolicyBlockedError(name);
}

async function forward(res: Response, path: string, init: { method?: string; body?: unknown } = {}): Promise<void> {
  try {
    const r = await cloudApiFetch(`/v1/cloud/connections${path}`, {
      method: init.method ?? "GET",
      ...(init.body !== undefined ? { body: init.body } : {}),
      timeoutMs: 15_000,
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text || "{}");
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** UI-only routes; mini-apps are refused by the caller check in mcpRoutes. */
export function registerOrgPolicyRoutes(app: Express, guard: (req: Request, res: Response) => boolean): void {
  app.get("/api/mcp/org/policy", async (req, res) => {
    if (!guard(req, res)) return;
    res.json(await getOrgPolicy(req.query.force === "1"));
  });
  app.patch("/api/mcp/org/policy", async (req, res) => {
    if (!guard(req, res)) return;
    clearOrgPolicyCache();
    await forward(res, "/policy", { method: "PATCH", body: req.body ?? {} });
  });
  app.get("/api/mcp/org/requests", async (req, res) => {
    if (!guard(req, res)) return;
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    await forward(res, `/requests?status=${encodeURIComponent(status)}`);
  });
  app.post("/api/mcp/org/requests", async (req, res) => {
    if (!guard(req, res)) return;
    await forward(res, "/requests", { method: "POST", body: req.body ?? {} });
  });
  app.post("/api/mcp/org/requests/:id/:action", async (req, res) => {
    if (!guard(req, res)) return;
    const action = req.params.action === "decide" ? "decide" : req.params.action === "cancel" ? "cancel" : null;
    if (!action) return void res.status(404).json({ error: "Unknown action" });
    if (action === "decide") clearOrgPolicyCache();
    await forward(res, `/requests/${encodeURIComponent(req.params.id)}/${action}`, {
      method: "POST",
      body: req.body ?? {},
    });
  });
}
