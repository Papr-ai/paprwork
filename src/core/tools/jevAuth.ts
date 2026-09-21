/**
 * Resolve how jev_decide reaches TypeSafe:
 * 1) Papr memory server proxy (PAPR_API_KEY) — same pattern as cloud API / AI proxy
 * 2) Direct TypeSafe BYOK (TYPESAFE_API_KEY)
 */

import {
  JEV_DEFAULT_ENDPOINT,
  JEV_KEY_NAME,
  type JevEvaluateInput,
} from "./jevClient.js";

export const JEV_PROXY_PATH = "/v1/typesafe/systemone";

export type JevAuthMode = "papr_proxy" | "typesafe_byok";

export interface JevResolvedAuth {
  mode: JevAuthMode;
  apiKey: string;
  endpoint: string;
  /** Which header carries the key for this endpoint. */
  authHeader: "x-api-key" | "bearer";
}

function memoryServerBaseUrl(): string {
  const fromEnv =
    process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "") ??
    process.env.PAPR_AI_PROXY_BASE_URL?.replace(/\/v1\/ai\/?$/, "").replace(/\/$/, "");
  return fromEnv ?? "https://memory.papr.ai";
}

function proxyEndpoint(): string {
  const path = process.env.JEV_PROXY_PATH?.trim() || JEV_PROXY_PATH;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${memoryServerBaseUrl()}${normalized}`;
}

async function resolveTypesafeByokKey(): Promise<string | null> {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const { getCustomKeysService } = await import(
      "../../gateway/services/CustomKeysService.js"
    );
    const service = getCustomKeysService();
    const value = await service.getKeyByName(JEV_KEY_NAME);
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  } catch {
    // Gateway-less tests use env only.
  }

  return null;
}

async function resolvePaprApiKey(): Promise<string | null> {
  try {
    const { getPaprApiKey } = await import("../../gateway/utils/keyResolver.js");
    const key = await getPaprApiKey();
    return key?.trim() ?? null;
  } catch {
    const env = process.env.PAPR_API_KEY?.trim();
    return env ?? null;
  }
}

/**
 * Prefer Papr proxy when logged in; fall back to TypeSafe BYOK.
 */
export async function resolveJevAuth(): Promise<JevResolvedAuth | null> {
  const paprKey = await resolvePaprApiKey();
  if (paprKey) {
    return {
      mode: "papr_proxy",
      apiKey: paprKey,
      endpoint: proxyEndpoint(),
      authHeader: "x-api-key",
    };
  }

  const typesafeKey = await resolveTypesafeByokKey();
  if (typesafeKey) {
    const direct =
      process.env.TYPESAFE_SYSTEMONE_URL?.trim() || JEV_DEFAULT_ENDPOINT;
    return {
      mode: "typesafe_byok",
      apiKey: typesafeKey,
      endpoint: direct,
      authHeader: "bearer",
    };
  }

  return null;
}

export function isJevProxyUnavailableStatus(status: number): boolean {
  return status === 404 || status === 501 || status === 502 || status === 503;
}

/**
 * If Papr proxy is not deployed yet, retry once with BYOK when available.
 */
export async function evaluateJevWithAuth(
  input: Omit<JevEvaluateInput, "apiKey" | "endpoint"> & {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<
  Awaited<ReturnType<typeof import("./jevClient.js").evaluateJev>> & {
    authMode: JevAuthMode;
  }
> {
  const { evaluateJev } = await import("./jevClient.js");
  const auth = await resolveJevAuth();
  if (!auth) {
    throw new Error("JEV_AUTH_MISSING");
  }

  const run = async (resolved: JevResolvedAuth) => {
    const result = await evaluateJev({
      ...input,
      apiKey: resolved.apiKey,
      endpoint: resolved.endpoint,
      authHeader: resolved.authHeader,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    });
    return { ...result, authMode: resolved.mode };
  };

  try {
    return await run(auth);
  } catch (error) {
    if (auth.mode !== "papr_proxy") {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const statusMatch = /Jev HTTP (\d+)/.exec(message);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (!isJevProxyUnavailableStatus(status)) {
      throw error;
    }

    const byok = await resolveTypesafeByokKey();
    if (!byok) {
      throw new Error(
        `${message} — Papr Jev proxy is unavailable and ${JEV_KEY_NAME} is not set. ` +
          "Add a TypeSafe key or ensure memory server exposes " +
          `${JEV_PROXY_PATH}.`,
      );
    }

    return run({
      mode: "typesafe_byok",
      apiKey: byok,
      endpoint: process.env.TYPESAFE_SYSTEMONE_URL?.trim() || JEV_DEFAULT_ENDPOINT,
      authHeader: "bearer",
    });
  }
}
