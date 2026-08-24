/**
 * Direct calls to the Papr memory server cloud API.
 * Prefer this over localhost /api/cloud proxy from gateway services — avoids
 * loopback races during startup and removes an extra hop.
 */

import { gzipSync } from "node:zlib";

import {
  appendCloudActingUserQuery,
  mergeCloudActingUserBody,
} from "./cloudActingUser.js";
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
  /** When set, overrides internal timeout (for long-lived SSE streams). */
  signal?: AbortSignal;
  /** When false, skip gzip request body even for large JSON payloads. */
  compressBody?: boolean;
  /**
   * Skip external_user_id on GET requests. Use for global public catalog routes
   * where acting-user scoping would hide other publishers' apps.
   */
  skipActingUser?: boolean;
}

const GZIP_MIN_BYTES = 1024;

function prepareCloudJsonBody(
  payload: unknown,
  compressBody: boolean,
): { body: string | Buffer; extraHeaders: Record<string, string> } {
  const raw = JSON.stringify(payload);
  const bytes = Buffer.from(raw, "utf8");
  if (!compressBody || bytes.length < GZIP_MIN_BYTES) {
    return { body: raw, extraHeaders: {} };
  }
  const compressed = gzipSync(bytes);
  if (compressed.length >= bytes.length) {
    return { body: raw, extraHeaders: {} };
  }
  return {
    body: compressed,
    extraHeaders: { "Content-Encoding": "gzip" },
  };
}

export async function cloudApiFetch(
  cloudPath: string,
  opts: CloudApiFetchOptions = {},
): Promise<Response> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY not configured. Login with Papr first.");
  }

  const controller = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? controller!.signal;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const fetchOpts: RequestInit = {
      method: opts.method ?? "GET",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
      },
      signal,
    };
    const method = fetchOpts.method ?? "GET";
    const hasJsonBody =
      opts.body !== undefined && method !== "GET" && method !== "HEAD";
    let pathWithActingUser = cloudPath;
    if (hasJsonBody) {
      const payload =
        typeof opts.body === "object" && opts.body !== null && !Array.isArray(opts.body)
          ? mergeCloudActingUserBody(opts.body as Record<string, unknown>)
          : opts.body;
      const prepared = prepareCloudJsonBody(payload, opts.compressBody !== false);
      fetchOpts.body = prepared.body;
      Object.assign(fetchOpts.headers as Record<string, string>, prepared.extraHeaders);
    } else if (opts.skipActingUser !== true) {
      pathWithActingUser = appendCloudActingUserQuery(cloudPath);
    }
    return await fetch(`${getMemoryServerBaseUrl()}${pathWithActingUser}`, fetchOpts);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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
