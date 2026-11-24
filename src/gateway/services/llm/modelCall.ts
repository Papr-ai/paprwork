/**
 * One model call (no tools loop) on the same stack chat and agent jobs use.
 *
 *   credentials  resolveJobSessionAuth: direct key or Claude/ChatGPT sign-in →
 *                Papr proxy → capability-matched fallback → default
 *   sign-in      pi-ai (Claude Code / ChatGPT backends), same model ids and
 *                payload patches as AgentService
 *   API key      AI SDK; Papr proxy via createProxyModel
 *   retries      sign-in rate limit → API key / Papr proxy; refused credential →
 *                next reachable provider (resolveJobSessionAuth helpers)
 *   web search   providers/piAiNativeWebSearch (pi-ai) / AI SDK provider tools
 *   cost         CostCalculation.calculateCostWithCache
 *
 * Exposed to scripts as POST /api/llm/complete (papr_llm.complete in Python), so
 * jobs and backend actions never re-implement auth headers or fallbacks.
 */

import { createHash } from "crypto";
import type { Provider } from "../../../core/types/index.js";

export interface ModelCallInput {
  prompt: string;
  /** Fixed instructions; cached. */
  system?: string;
  /** Fixed reference material placed before the prompt; cached. */
  context?: string;
  provider?: "anthropic" | "openai";
  model?: string;
  maxTokens?: number;
  webSearch?: boolean;
  /** Prompt caching (default true). */
  cache?: boolean;
  /** Claude cache lifetime: 5m (default) or 1h. */
  cacheTtl?: "5m" | "1h";
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Cloud only: credentials to use, in fallback order, instead of resolving
   * them on this machine. The memory server resolves them from the vault per
   * run; they live only for this call.
   */
  credentials?: ModelCallCredential[];
}

export interface ModelCallCredential {
  provider: string;
  authType: "oauth" | "apiKey";
  token: string;
  usePaprProxy?: boolean;
}

export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelCallResult {
  text: string;
  provider: string;
  model: string;
  authType: "oauth" | "apiKey";
  route: "sign-in" | "api-key" | "papr-proxy";
  usage: ModelCallUsage;
  costUsd: number;
  /** Credentials tried before this one succeeded (rate limit / refusal). */
  retries: string[];
}

export type Auth = {
  provider: Provider;
  model: string;
  apiKey: string;
  authType: "oauth" | "apiKey";
  usePaprProxy?: boolean;
};

const DEFAULT_MODEL: Record<"anthropic" | "openai", string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5-6-sol",
};

const RATE_LIMIT = /usage limit|rate limit|try again in|\b429\b/i;

class CallError extends Error {
  constructor(message: string, readonly kind: "rate_limit" | "auth" | "other") {
    super(message);
  }
}

async function classify(message: string): Promise<CallError> {
  if (RATE_LIMIT.test(message)) return new CallError(message, "rate_limit");
  const { isProviderAuthError } = await import("../../utils/autoProviderHealth.js");
  return new CallError(message, isProviderAuthError(message) ? "auth" : "other");
}

export async function resolveModelCallAuth(
  provider?: "anthropic" | "openai",
  model?: string,
): Promise<Auth> {
  const { resolveJobSessionAuth } = await import("../../utils/resolveJobSessionAuth.js");
  let p: Provider;
  let m: string;
  if (provider) {
    p = provider;
    m = model ?? DEFAULT_MODEL[provider];
  } else {
    const { getDefaultProviderAndModel } = await import("../../utils/defaultProvider.js");
    const d = await getDefaultProviderAndModel();
    p = d.provider;
    m = model ?? d.model;
  }
  return resolveJobSessionAuth({ provider: p, model: m });
}

/** Supplied credentials → Auth list; the requested model is kept only on its own provider. */
export function authsFromCredentials(
  credentials: ModelCallCredential[],
  provider?: "anthropic" | "openai",
  model?: string,
): Auth[] {
  const out: Auth[] = [];
  for (const c of credentials) {
    const family = c.provider.startsWith("openai") ? "openai" : c.provider === "anthropic" ? "anthropic" : null;
    if (!family || !c.token?.trim()) continue;
    const keepModel = !!model && (!provider || provider === family);
    out.push({
      provider: family as Provider,
      model: keepModel ? model! : DEFAULT_MODEL[family],
      apiKey: c.token.trim(),
      authType: c.authType === "oauth" ? "oauth" : "apiKey",
      usePaprProxy: c.usePaprProxy === true,
    });
  }
  return out;
}

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  if (!input.prompt?.trim()) throw new Error("prompt is required");
  if (input.credentials) return callWithCredentials(input, authsFromCredentials(input.credentials, input.provider, input.model));
  let auth = await resolveModelCallAuth(input.provider, input.model);
  const retries: string[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { ...(await callOnce(input, auth)), retries };
    } catch (err) {
      const e = err instanceof CallError ? err : await classify((err as Error).message ?? String(err));
      retries.push(`${auth.provider}/${auth.model} (${auth.usePaprProxy ? "proxy" : auth.authType}): ${e.message.slice(0, 200)}`);
      const helpers = await import("../../utils/resolveJobSessionAuth.js");
      let next: Auth | null = null;
      if (e.kind === "rate_limit" && auth.authType === "oauth") {
        const creds = await helpers.resolveOAuthRateLimitRetryCredentials(auth.provider, auth.model);
        next = creds ? { ...auth, ...creds } : null;
      } else if (e.kind === "auth") {
        next = await helpers.resolveAuthRefusalRetry(auth.provider);
      }
      if (!next) throw new Error(`Model call failed (${auth.provider}/${auth.model}): ${e.message}`);
      console.warn(`[modelCall] ${e.kind} on ${auth.provider}/${auth.model} — retrying on ${next.provider}/${next.model}`);
      auth = next;
    }
  }
  throw new Error(`Model call failed after retries: ${retries.join(" | ")}`);
}

/** Cloud: try each supplied credential in order; move on after a rate limit or a refused credential. */
async function callWithCredentials(input: ModelCallInput, auths: Auth[]): Promise<ModelCallResult> {
  if (!auths.length) throw new CallError("No Claude or ChatGPT credential is connected for this account", "auth");
  const retries: string[] = [];
  for (const auth of auths) {
    try {
      return { ...(await callOnce(input, auth)), retries };
    } catch (err) {
      const e = err instanceof CallError ? err : await classify((err as Error).message ?? String(err));
      retries.push(`${auth.provider}/${auth.model} (${auth.usePaprProxy ? "proxy" : auth.authType}): ${e.message.slice(0, 200)}`);
      if (e.kind === "other") throw new Error(`Model call failed (${auth.provider}/${auth.model}): ${e.message}`);
    }
  }
  throw new Error(`Model call failed on every connected credential: ${retries.join(" | ")}`);
}

async function callOnce(input: ModelCallInput, auth: Auth): Promise<Omit<ModelCallResult, "retries">> {
  const usePiAi = auth.authType === "oauth" && !auth.usePaprProxy;
  const out = usePiAi ? await callPiAi(input, auth) : await callAiSdk(input, auth);
  const { calculateCostWithCache } = await import("../CostCalculation.js");
  const costUsd = calculateCostWithCache(out.model, {
    promptTokens: out.usage.inputTokens,
    completionTokens: out.usage.outputTokens,
    cacheReadTokens: out.usage.cacheReadTokens,
    cacheWriteTokens: out.usage.cacheWriteTokens,
  });
  console.log(
    `[modelCall] ${auth.provider}/${out.model} ${out.route} in=${out.usage.inputTokens} ` +
      `cache_read=${out.usage.cacheReadTokens} cache_write=${out.usage.cacheWriteTokens} out=${out.usage.outputTokens}`,
  );
  return { ...out, provider: auth.provider === "openai-codex" ? "openai" : auth.provider, authType: auth.authType, costUsd };
}

type Partial_ = Omit<ModelCallResult, "retries" | "costUsd" | "provider" | "authType">;

function cacheKey(...parts: Array<string | undefined>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex").slice(0, 32);
}

async function callPiAi(input: ModelCallInput, auth: Auth): Promise<Partial_> {
  const { getModel, completeSimple } = await import("@mariozechner/pi-ai");
  const isOpenAI = auth.provider === "openai" || auth.provider === "openai-codex";
  const piProvider = isOpenAI ? "openai-codex" : "anthropic";
  const { normalizeOpenAIModelId } = await import("../../utils/modelNormalizer.js");
  const modelId = isOpenAI ? normalizeOpenAIModelId(auth.model) : auth.model;
  const lookup = getModel as (p: string, m: string) => any;
  // pi-ai's registry lags new models: reuse a listed one with the id swapped,
  // the same way AgentService builds unlisted models.
  const base = lookup(piProvider, modelId) ?? lookup(piProvider, isOpenAI ? "gpt-5.4" : "claude-sonnet-4-6");
  if (!base) throw new CallError(`pi-ai has no ${piProvider} model to build on`, "other");
  const model = base.id === modelId ? base : { ...base, id: modelId, name: modelId };

  const cache = input.cache !== false;
  const apiKey = isOpenAI
    ? (await import("../../utils/resolveJobProviderModel.js")).normalizeChatGptOAuthToken(auth.apiKey)
    : auth.apiKey;
  let opts: Record<string, any> = {
    apiKey,
    maxTokens: input.maxTokens ?? 4096,
    signal: input.signal,
    sessionId: cache ? cacheKey(modelId, input.system, input.context) : undefined,
    cacheRetention: !cache ? "none" : input.cacheTtl === "1h" ? "long" : "short",
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
  if (isOpenAI) {
    const { augmentPiAiCodexStreamOptions } = await import("../providers/piAiCodexResponsesLite.js");
    opts = augmentPiAiCodexStreamOptions(modelId, opts as any) as any;
  } else {
    const { augmentPiAiAnthropicStreamOptions } = await import("../providers/piAiAnthropicAdaptiveThinking.js");
    // Single answers: thinking off (cheaper, faster); keeps the Claude Code user agent.
    opts = augmentPiAiAnthropicStreamOptions(modelId, "low", opts as any, false) as any;
    if (cache && input.context) {
      // pi-ai marks the system prompt and the LAST user block; mark the fixed
      // context block too so it is reused when only the prompt changes.
      const inner = opts.onPayload;
      const ttl = input.cacheTtl === "1h" ? { ttl: "1h" } : {};
      opts.onPayload = async (params: any, m: unknown) => {
        const body = ((inner ? await inner(params, m) : undefined) ?? params) as any;
        const first = body.messages?.[0]?.content?.[0];
        if (first && first.type === "text") first.cache_control = { type: "ephemeral", ...ttl };
        return body;
      };
    }
  }
  if (input.webSearch) {
    const { withPiAiNativeWebSearch } = await import("../providers/piAiNativeWebSearch.js");
    opts = withPiAiNativeWebSearch(piProvider, opts as any);
  }

  const content = [input.context, input.prompt]
    .filter((t): t is string => !!t)
    .map((text) => ({ type: "text" as const, text }));
  const message = await completeSimple(
    model,
    {
      systemPrompt: input.system || undefined,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    },
    opts as any,
  );
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw await classify(message.errorMessage ?? message.stopReason);
  }
  const text = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  const u = message.usage ?? ({} as any);
  return {
    text,
    model: modelId,
    route: "sign-in",
    usage: {
      inputTokens: u.input ?? 0,
      outputTokens: u.output ?? 0,
      cacheReadTokens: u.cacheRead ?? 0,
      cacheWriteTokens: u.cacheWrite ?? 0,
    },
  };
}

async function callAiSdk(input: ModelCallInput, auth: Auth): Promise<Partial_> {
  const { generateText } = await import("ai");
  const isOpenAI = auth.provider === "openai" || auth.provider === "openai-codex";
  const { normalizeOpenAIModelId } = await import("../../utils/modelNormalizer.js");
  const modelId = isOpenAI ? normalizeOpenAIModelId(auth.model) : auth.model;
  const cache = input.cache !== false;
  const ttl = input.cacheTtl === "1h" ? { ttl: "1h" as const } : {};
  const anthropicCache = cache && !isOpenAI
    ? { anthropic: { cacheControl: { type: "ephemeral" as const, ...ttl } } }
    : undefined;

  let model: any;
  const tools: Record<string, any> = {};
  if (auth.usePaprProxy) {
    const { createProxyModel } = await import("../../utils/paprProxyProvider.js");
    model = await createProxyModel(isOpenAI ? "openai" : auth.provider, modelId, auth.apiKey);
    // Native search tools target direct provider APIs (same rule as chat).
  } else if (isOpenAI) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const client = createOpenAI({ apiKey: auth.apiKey });
    model = client.responses(modelId);
    if (input.webSearch) tools.web_search = client.tools.webSearch({});
  } else if (auth.provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const client = createAnthropic({ apiKey: auth.apiKey });
    model = client(modelId);
    if (input.webSearch) tools.web_search = client.tools.webSearch_20250305({ maxUses: 5 });
  } else {
    throw new CallError(`Provider ${auth.provider} is not supported for script model calls`, "auth");
  }

  const messages: any[] = [];
  if (input.system) {
    messages.push({ role: "system", content: input.system, ...(anthropicCache ? { providerOptions: anthropicCache } : {}) });
  }
  const parts: any[] = [];
  if (input.context) parts.push({ type: "text", text: input.context, ...(anthropicCache ? { providerOptions: anthropicCache } : {}) });
  parts.push({ type: "text", text: input.prompt });
  messages.push({ role: "user", content: parts });

  const result = await generateText({
    model,
    messages,
    maxOutputTokens: input.maxTokens ?? 4096,
    abortSignal: input.signal,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(Object.keys(tools).length ? { tools } : {}),
    ...(isOpenAI && cache
      ? { providerOptions: { openai: { promptCacheKey: cacheKey(modelId, input.system, input.context) } } }
      : {}),
  });
  const u: any = result.usage ?? {};
  return {
    text: result.text,
    model: modelId,
    route: auth.usePaprProxy ? "papr-proxy" : "api-key",
    usage: {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0,
      cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    },
  };
}
