/**
 * GPT-5.6 Luna on ChatGPT OAuth requires Codex "Responses Lite" transport.
 * Sol and Terra work with the standard openai-codex-responses path; Luna
 * returns "Model not found" without the Lite envelope.
 *
 * Mirrors OpenCode's codex plugin fix (PR #36143): reshape request body and
 * set Responses Lite headers before pi-ai sends to chatgpt.com/backend-api.
 */

import { randomUUID } from "node:crypto";

export const CODEX_RESPONSES_LITE_HEADER =
  "x-openai-internal-codex-responses-lite";
export const CODEX_COMPATIBILITY_VERSION = "0.144.0";

/** Only Luna needs Responses Lite on OAuth — Sol/Terra use standard transport */
const RESPONSES_LITE_MODELS = new Set(["gpt-5.6-luna"]);

/** Papr chat session → stable Codex session UUID for Responses Lite affinity */
const codexSessionIds = new Map<string, string>();

export interface PiAiCodexStreamOptions {
  apiKey: string;
  sessionId: string;
  signal?: AbortSignal;
  reasoning?: string;
  cacheRetention?: "none" | "short" | "long";
  headers?: Record<string, string>;
  onPayload?: (
    params: Record<string, unknown>,
    model: unknown,
  ) =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCodexModelId(modelId: string): string {
  return modelId.replace(/gpt-5-6/g, "gpt-5.6");
}

export function requiresCodexResponsesLite(modelId: string): boolean {
  return RESPONSES_LITE_MODELS.has(normalizeCodexModelId(modelId));
}

function resolveCodexSessionId(sourceSessionId: string): string {
  const existing = codexSessionIds.get(sourceSessionId);
  if (existing) {
    return existing;
  }
  const id = randomUUID();
  codexSessionIds.set(sourceSessionId, id);
  return id;
}

function stripImageDetail(input: unknown): void {
  if (Array.isArray(input)) {
    for (const item of input) {
      stripImageDetail(item);
    }
    return;
  }
  if (!isRecord(input)) {
    return;
  }
  if (input.type === "input_image") {
    delete input.detail;
  }
  for (const value of Object.values(input)) {
    stripImageDetail(value);
  }
}

export function transformToResponsesLite(
  request: Record<string, unknown>,
  codexSessionId: string,
): Record<string, unknown> {
  if (!Array.isArray(request.input)) {
    throw new Error("Responses Lite requires an input array");
  }
  const tools = request.tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    throw new Error("Responses Lite requires a tools array");
  }
  const instructions = request.instructions;
  if (instructions !== undefined && typeof instructions !== "string") {
    throw new Error("Responses Lite requires string instructions");
  }

  const input: unknown[] = [
    {
      type: "additional_tools",
      role: "developer",
      tools: Array.isArray(tools) ? tools : [],
    },
    ...(typeof instructions === "string"
      ? [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: instructions }],
          },
        ]
      : []),
    ...request.input,
  ];

  const existingReasoning = isRecord(request.reasoning) ? request.reasoning : {};

  const result: Record<string, unknown> = {
    ...request,
    input,
    tool_choice: "auto",
    parallel_tool_calls: false,
    prompt_cache_key: codexSessionId,
    reasoning: {
      ...existingReasoning,
      context: "all_turns",
    },
  };

  delete result.tools;
  delete result.instructions;

  stripImageDetail(result.input);

  return result;
}

export function augmentPiAiCodexStreamOptions(
  modelId: string,
  base: PiAiCodexStreamOptions,
): PiAiCodexStreamOptions {
  if (!requiresCodexResponsesLite(modelId)) {
    return base;
  }

  const codexSessionId = resolveCodexSessionId(base.sessionId);
  const existingOnPayload = base.onPayload;

  console.log(
    `[AgentService] Applying Codex Responses Lite for ${normalizeCodexModelId(modelId)} ` +
      `(codexSessionId=${codexSessionId})`,
  );

  return {
    ...base,
    sessionId: codexSessionId,
    headers: {
      ...base.headers,
      "session-id": codexSessionId,
      "x-session-affinity": codexSessionId,
      version: CODEX_COMPATIBILITY_VERSION,
      [CODEX_RESPONSES_LITE_HEADER]: "true",
    },
    onPayload: async (body, model) => {
      let transformed = transformToResponsesLite(
        body as Record<string, unknown>,
        codexSessionId,
      );
      if (existingOnPayload) {
        const next = await existingOnPayload(transformed, model);
        if (next !== undefined) {
          transformed = next;
        }
      }
      return transformed;
    },
  };
}
