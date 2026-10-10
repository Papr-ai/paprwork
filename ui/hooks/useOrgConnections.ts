/**
 * Org connection rules + requests via the gateway (/api/mcp/org/*), which
 * proxies to the memory server. Refreshes on the "mcp-org:stale" broadcast the
 * gateway sends when a request/approval event arrives on the change feed.
 */
import { useCallback, useEffect, useState } from "react";

const GATEWAY = "http://localhost:18789";

export type ConnectMode = "all" | "approved" | "none";

export interface OrgConnectionPolicy {
  mode: ConnectMode;
  approved: string[];
  maxShare: "user" | "members" | "namespace" | "org";
  maxPenAccess: "read" | "ask" | "full";
  setupBy: "admins" | "anyone";
}

export interface ConnectionRequest {
  id: string;
  serverId: string;
  serverName: string;
  requesters: { userId: string; note?: string; at: string }[];
  status: "pending" | "approved" | "declined" | "cancelled";
  reason?: string | null;
  updatedAt?: string;
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${GATEWAY}/api/mcp/org${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
  if (!res.ok) throw new Error(data.detail || data.error || `Request failed (${res.status})`);
  return data;
}

export function canConnect(policy: OrgConnectionPolicy | null, serverId: string): boolean {
  if (!policy || policy.mode === "all") return true;
  if (policy.mode === "none") return false;
  return policy.approved.includes(serverId.toLowerCase());
}

const CACHE_KEY = "papr.orgConnectionPolicy.v1";

function readCached(): { policy: OrgConnectionPolicy | null; isAdmin: boolean } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as { policy: OrgConnectionPolicy | null; isAdmin: boolean }) : null;
  } catch {
    return null;
  }
}

function writeCached(v: { policy: OrgConnectionPolicy | null; isAdmin: boolean }): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ policy: v.policy, isAdmin: v.isAdmin }));
  } catch {
    /* storage full or blocked: the live fetch still fills it in */
  }
}

export function useOrgConnections() {
  // Last known rules render immediately; the live fetch replaces them.
  const [cached] = useState(readCached);
  const [policy, setPolicy] = useState<OrgConnectionPolicy | null>(cached?.policy ?? null);
  const [isAdmin, setIsAdmin] = useState(cached?.isAdmin ?? false);
  const [requests, setRequests] = useState<ConnectionRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    try {
      // In parallel: the policy is a cloud round trip (~2s cold); requests used to wait behind it.
      const [p, r] = await Promise.all([
        call<{ policy: OrgConnectionPolicy | null; isAdmin: boolean }>(`/policy${force ? "?force=1" : ""}`),
        call<{ requests: ConnectionRequest[] }>("/requests?status=pending").catch(() => ({ requests: [] as ConnectionRequest[] })),
      ]);
      setPolicy(p.policy);
      setIsAdmin(p.isAdmin);
      writeCached(p);
      setRequests(r.requests ?? []);
      setError(null);
    } catch (e) {
      // Offline or logged out: no org rules, nothing to request.
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onBroadcast = (event: Event) => {
      if ((event as CustomEvent<{ type?: string }>).detail?.type === "mcp-org:stale") void refresh(true);
    };
    window.addEventListener("gateway-broadcast", onBroadcast);
    return () => window.removeEventListener("gateway-broadcast", onBroadcast);
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refresh(true);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [refresh],
  );

  return {
    policy,
    isAdmin,
    requests,
    error,
    refresh,
    updatePolicy: (patch: Partial<OrgConnectionPolicy>) => run(() => call("/policy", "PATCH", patch)),
    request: (serverId: string, serverName: string, note?: string) =>
      run(() => call("/requests", "POST", { serverId, serverName, note })),
    cancel: (id: string) => run(() => call(`/requests/${id}/cancel`, "POST")),
    decide: (id: string, approve: boolean, reason?: string) =>
      run(() => call(`/requests/${id}/decide`, "POST", { approve, reason })),
  };
}
