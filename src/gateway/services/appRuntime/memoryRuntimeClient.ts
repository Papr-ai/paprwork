/**
 * Cloud App Host → Memory server runtime APIs (multi-tenant credentials).
 *
 * Uses PAPR_CLOUD_APP_HOST_KEY for service auth. Memory validates publish ACL
 * and returns Turso/repo credentials for the app owner — not the host key identity.
 */

import type { AppRuntimeRouteAuth } from "./types.js";
import { getMemoryServerBaseUrl, cloudApiFetch } from "../../utils/cloudApiClient.js";
import { buildCloudVaultRequestBody } from "../../../core/utils/cloudReposScope.js";

function getCloudAppHostKey(): string {
  const key = process.env.PAPR_CLOUD_APP_HOST_KEY;
  if (!key) {
    throw new Error(
      "PAPR_CLOUD_APP_HOST_KEY is required for Cloud App Host runtime calls",
    );
  }
  return key;
}

const DEFAULT_RUNTIME_FETCH_TIMEOUT_MS = Number(
  process.env.CLOUD_APP_HOST_MEMORY_TIMEOUT_MS ?? 90_000,
);

/** Abort hung memory.papr.ai calls before Cloud Run's 120s request limit. */
export async function runtimeFetch(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_RUNTIME_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Memory server request timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function runtimeHeaders(auth: AppRuntimeRouteAuth): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Cloud-App-Host-Key": getCloudAppHostKey(),
  };
  if (auth.paprApiKey) {
    headers["X-API-Key"] = auth.paprApiKey;
  }
  if (auth.sessionToken) {
    headers["X-Session-Token"] = auth.sessionToken;
  }
  return headers;
}

/** Common auth fields for memory runtime POST bodies (session + key + share link). */
export function runtimeAuthPayload(
  auth: AppRuntimeRouteAuth,
): Record<string, string> {
  const payload: Record<string, string> = {
    namespaceId: auth.namespaceId,
    slug: auth.slug,
  };
  if (auth.paprApiKey) payload.paprApiKey = auth.paprApiKey;
  if (auth.shareToken) payload.shareToken = auth.shareToken;
  if (auth.sessionToken) payload.sessionToken = auth.sessionToken;
  return payload;
}

export async function fetchRuntimeDbToken(
  auth: AppRuntimeRouteAuth,
  database: string,
): Promise<{ tursoUrl: string; authToken: string }> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/db-token`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        database,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Runtime db-token failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { tursoUrl: string; authToken: string };
  return { tursoUrl: json.tursoUrl, authToken: json.authToken };
}

export async function fetchRuntimeRepoFile(
  auth: AppRuntimeRouteAuth,
  relativePath: string,
): Promise<{ content: string; contentType: string } | null> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/repo-file`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        relativePath,
      }),
    },
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(
      `Runtime repo-file failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { content: string; contentType: string };
  return json;
}

export async function fetchRuntimeVaultKeyNames(
  auth: AppRuntimeRouteAuth,
): Promise<string[]> {
  if (!auth.sessionToken) {
    return [];
  }
  try {
    const scope = auth.namespaceId ? "namespace" : "user";
    const query = scope === "namespace"
      ? `scope=namespace&namespace_id=${encodeURIComponent(auth.namespaceId)}`
      : "scope=user";
    const res = await runtimeFetch(
      `${getMemoryServerBaseUrl()}/v1/cloud/vault/keys?${query}`,
      {
        method: "GET",
        headers: runtimeHeaders(auth),
      },
    );
    if (!res.ok) {
      return [];
    }
    const json = (await res.json()) as { keys?: Array<{ name: string }> };
    return (json.keys ?? []).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function syncRuntimeVaultKeys(
  auth: AppRuntimeRouteAuth,
  keys: Array<{ name: string; value: string }>,
): Promise<{ synced: number }> {
  if (!auth.sessionToken) {
    throw new Error("Sign in required to save credentials");
  }
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/vault/sync`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify(buildCloudVaultRequestBody(keys, auth.namespaceId ? "namespace" : "user")),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Vault sync failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as { synced: number };
}

export interface RuntimeVaultResolveResult {
  env: Record<string, string>;
  missing: string[];
}

/** Server-side only: resolve owner vs visitor vault keys for cloud bash/jobs. */
export async function resolveRuntimeVaultEnv(
  auth: AppRuntimeRouteAuth,
  options?: { keyNames?: string[] },
): Promise<RuntimeVaultResolveResult> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/vault-resolve`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        keyNames: options?.keyNames,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Runtime vault-resolve failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as RuntimeVaultResolveResult;
  return { env: json.env ?? {}, missing: json.missing ?? [] };
}

export interface RuntimeVaultClientResolveResult {
  keys: Record<string, string>;
  missing: string[];
  rejected: string[];
}

/** Browser-safe: resolve publishable vault keys for mini-app frontend. */
export async function resolveRuntimeVaultClientKeys(
  auth: AppRuntimeRouteAuth,
  options?: { keyNames?: string[] },
): Promise<RuntimeVaultClientResolveResult> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/vault-client-resolve`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        keyNames: options?.keyNames,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Runtime vault-client-resolve failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as RuntimeVaultClientResolveResult;
  return {
    keys: json.keys ?? {},
    missing: json.missing ?? [],
    rejected: json.rejected ?? [],
  };
}

export interface RuntimeBashRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RuntimeJobRunResult {
  jobId: string;
  name?: string;
  type?: string;
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  lastOutput?: string;
  error?: string | null;
  backend?: string;
  tier?: string;
}

export interface RuntimeJobSummary {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  lastRunAt?: string;
  completedAt?: string;
}

/** Run a synced job in cloud sandbox (GKE or process fallback on memory server). */
export async function runRuntimeJob(
  auth: AppRuntimeRouteAuth,
  input: {
    jobId: string;
    params?: Record<string, string>;
    timeoutMs?: number;
    tier?: "sandbox" | "ephemeral";
  },
): Promise<RuntimeJobRunResult> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/job-run`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        jobId: input.jobId,
        params: input.params,
        timeoutMs: input.timeoutMs,
        tier: input.tier ?? "sandbox",
      }),
    },
    Math.max(DEFAULT_RUNTIME_FETCH_TIMEOUT_MS, (input.timeoutMs ?? 60_000) + 5_000),
  );
  if (!res.ok) {
    throw new Error(
      `Runtime job-run failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as RuntimeJobRunResult;
}

/** List jobs from the app owner's git-synced workspace. */
export async function listRuntimeJobs(
  auth: AppRuntimeRouteAuth,
): Promise<{ jobs: RuntimeJobSummary[]; count: number }> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/jobs-list`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Runtime jobs-list failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as { jobs: RuntimeJobSummary[]; count: number };
}

/** Desktop gateway alive ping — cloud scheduler defers when heartbeat is fresh. */
export async function sendDesktopHeartbeat(): Promise<void> {
  const res = await cloudApiFetch("/v1/cloud/runtime/heartbeat", {
    method: "POST",
    body: {},
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    throw new Error(
      `Desktop heartbeat failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

/** One-shot bash on cloud (memory server ephemeral runner). */
export async function runRuntimeBash(
  auth: AppRuntimeRouteAuth,
  input: { command: string; timeoutMs?: number; keyNames?: string[] },
): Promise<RuntimeBashRunResult> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/bash-run`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        command: input.command,
        timeoutMs: input.timeoutMs,
        keyNames: input.keyNames,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Runtime bash-run failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as RuntimeBashRunResult;
  return {
    stdout: json.stdout ?? "",
    stderr: json.stderr ?? "",
    exitCode: json.exitCode ?? 1,
  };
}

import { parseRuntimeSseStream } from "../appAgentChat/parseRuntimeSseStream.js";
import type { GatewayStreamRawEvent } from "../appAgentChat/mapGatewayStreamToAppAgentEvents.js";

export type RuntimeAppAgentWarmResult =
  | { status: "ready" | "warming"; expiresAt?: string }
  | "unavailable";

/** Pre-warm gateway sandbox for embedded app chat (bubble-open intent). */
export async function warmRuntimeAppAgentChat(
  auth: AppRuntimeRouteAuth,
  input: {
    sessionId: string;
    appId: string;
    subAgentId: string;
    jobId: string;
  },
): Promise<RuntimeAppAgentWarmResult> {
  const res = await runtimeFetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/app-agent/warm`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        sessionId: input.sessionId,
        appId: input.appId,
        subAgentId: input.subAgentId,
        jobId: input.jobId,
      }),
    },
  );
  if (res.status === 404) {
    return "unavailable";
  }
  if (!res.ok) {
    throw new Error(
      `Runtime app-agent warm failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { status?: string; expiresAt?: string };
  const status = json.status === "ready" ? "ready" : "warming";
  return {
    status,
    ...(json.expiresAt ? { expiresAt: json.expiresAt } : {}),
  };
}

/**
 * Memory-server SSE for app-agent chat.
 * Memory prepares a Cloud Agent Gateway run and proxies POST /internal/agent/stream.
 */
export async function streamRuntimeAppAgentChat(
  auth: AppRuntimeRouteAuth,
  input: {
    sessionId: string;
    appId: string;
    subAgentId: string;
    userMessage: string;
    prompt: string;
    jobId: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  },
): Promise<AsyncIterable<GatewayStreamRawEvent>> {
  const res = await fetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/app-agent/stream`,
    {
      method: "POST",
      headers: runtimeHeaders(auth),
      body: JSON.stringify({
        ...runtimeAuthPayload(auth),
        sessionId: input.sessionId,
        appId: input.appId,
        subAgentId: input.subAgentId,
        userMessage: input.userMessage,
        prompt: input.prompt,
        jobId: input.jobId,
        history: input.history,
      }),
    },
  );
  if (res.status === 404) {
    throw new Error(
      "Cloud app assistant streaming is not available on this Papr server. " +
        "Deploy memory-server with /v1/cloud/apps/runtime/app-agent/stream (Cloud Agent Gateway proxy).",
    );
  }
  if (!res.ok) {
    throw new Error(
      `Runtime app-agent stream failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  if (!res.body) {
    throw new Error("Runtime app-agent stream returned empty body");
  }
  return parseRuntimeSseStream(res.body);
}
