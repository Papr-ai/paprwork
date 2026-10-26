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
import { Agent } from "undici";

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
  /** Request-scoped key (cloud app host session enrichment). */
  apiKey?: string;
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

const DEFAULT_UNDICI_HEADERS_TIMEOUT_MS = 300_000;
const longDispatchers = new Map<number, Agent>();

/** Shared undici Agent per timeout bucket (minute granularity). */
function longRequestDispatcher(timeoutMs: number): Agent {
  const bucket = Math.ceil(timeoutMs / 60_000) * 60_000;
  let agent = longDispatchers.get(bucket);
  if (!agent) {
    agent = new Agent({ headersTimeout: bucket, bodyTimeout: bucket });
    longDispatchers.set(bucket, agent);
  }
  return agent;
}

export async function cloudApiFetch(
  cloudPath: string,
  opts: CloudApiFetchOptions = {},
): Promise<Response> {
  const apiKey = opts.apiKey ?? (await getPaprApiKey());
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
    // Node's fetch (undici) aborts if response headers take > 300s
    // (UND_ERR_HEADERS_TIMEOUT → "fetch failed"), regardless of our own
    // timeout. Synchronous calls such as /runtime/job-run wait for the whole
    // job, so give long requests a dispatcher whose limits match timeoutMs.
    if (timeoutMs > DEFAULT_UNDICI_HEADERS_TIMEOUT_MS) {
      // Node's global fetch accepts any undici Dispatcher; the npm undici
      // types differ nominally from Node's bundled copy, hence the cast.
      (fetchOpts as unknown as { dispatcher: unknown }).dispatcher =
        longRequestDispatcher(timeoutMs);
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
