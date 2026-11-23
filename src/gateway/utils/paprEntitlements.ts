/**
 * Can this Papr account use premium models on Papr credits?
 *
 * Reads GET {proxy}/entitlements (memory server). Cached per API key for 60s.
 * Fails OPEN: a network error, or an older server without the endpoint, returns
 * premium=true so nothing is blocked client-side; the server's own 402 still
 * applies in that case.
 */

export interface PaprEntitlements {
  premium: boolean;
  reason?: string | null;
}

const TTL_MS = 60_000;
const cache = new Map<string, { value: PaprEntitlements; at: number }>();

function proxyBase(): string {
  return (
    process.env.PAPR_AI_PROXY_BASE_URL ||
    (process.env.PAPR_MEMORY_SERVER_URL
      ? `${process.env.PAPR_MEMORY_SERVER_URL.replace(/\/$/, "")}/v1/ai`
      : "https://memory.papr.ai/v1/ai")
  ).replace(/\/$/, "");
}

export function clearPaprEntitlementsCache(): void {
  cache.clear();
}

export async function getPaprEntitlements(
  paprApiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PaprEntitlements> {
  const hit = cache.get(paprApiKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: PaprEntitlements = { premium: true, reason: "unknown" };
  try {
    const res = await fetchImpl(`${proxyBase()}/entitlements`, {
      headers: { "X-API-Key": paprApiKey },
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { premium?: unknown; reason?: unknown };
      value = {
        premium: body.premium !== false,
        reason: typeof body.reason === "string" ? body.reason : null,
      };
    }
  } catch {
    // Fail open — the server still enforces.
  }
  if (cache.size > 64) cache.clear();
  cache.set(paprApiKey, { value, at: Date.now() });
  return value;
}
