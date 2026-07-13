/**
 * Direct calls to the Papr memory server cloud API.
 * Prefer this over localhost /api/cloud proxy from gateway services — avoids
 * loopback races during startup and removes an extra hop.
 */

import { getPaprApiKey } from "./keyResolver.js";

export function getMemoryServerBaseUrl(): string {
  return (
    process.env.PAPR_MEMORY_SERVER_URL ??
    process.env.PAPR_AI_PROXY_BASE_URL?.replace(/\/v1\/ai\/?$/, "") ??
    "https://memory.papr.ai"
  );
}

export interface CloudApiFetchOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

export async function cloudApiFetch(
  cloudPath: string,
  opts: CloudApiFetchOptions = {},
): Promise<Response> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY not configured. Login with Papr first.");
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOpts: RequestInit = {
      method: opts.method ?? "GET",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };
    if (opts.body !== undefined && fetchOpts.method !== "GET" && fetchOpts.method !== "HEAD") {
      fetchOpts.body = JSON.stringify(opts.body);
    }
    return await fetch(`${getMemoryServerBaseUrl()}${cloudPath}`, fetchOpts);
  } finally {
    clearTimeout(timer);
  }
}

/** Retry until Papr login key is available (IPC may lag gateway startup slightly). */
export async function waitForPaprApiKey(maxWaitMs = 30_000): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const key = await getPaprApiKey();
    if (key) return key;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
