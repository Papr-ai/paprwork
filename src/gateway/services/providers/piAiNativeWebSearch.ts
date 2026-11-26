/**
 * Provider web search for pi-ai routes (Claude sign-in, ChatGPT sign-in, and the
 * shared model-call helper).
 *
 * pi-ai only knows function tools: anything in `context.tools` is converted to
 * a function definition. Passing a native tool there produced a broken request
 * (Anthropic: convertTools read `parameters.properties` of undefined; ChatGPT: a
 * bogus `web_search` *function* the model could call but nothing executed). So
 * native search never goes into `context.tools`. It is added to the outgoing
 * request body in pi-ai's onPayload hook, after every other payload patch.
 *
 * pi-ai ignores the server-side blocks these tools return (server_tool_use,
 * web_search_tool_result, web_search_call); the model's text, which carries the
 * citations, comes through as normal text.
 */

export type NativeSearchProvider = "anthropic" | "openai-codex" | "openai";

type OnPayload = (
  params: any,
  model: unknown,
) => unknown | undefined | Promise<unknown | undefined>;

/** Anthropic server tool; works with API keys and Claude sign-in tokens. */
export const ANTHROPIC_WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
} as const;

/** OpenAI Responses / ChatGPT Codex hosted tool. */
export const OPENAI_WEB_SEARCH_TOOL = { type: "web_search" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adds the provider's search tool to an already-built request body. Exported for tests. */
export function addNativeWebSearchToPayload(
  provider: NativeSearchProvider,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const tool = provider === "anthropic" ? ANTHROPIC_WEB_SEARCH_TOOL : OPENAI_WEB_SEARCH_TOOL;
  const has = (tools: unknown[]) =>
    tools.some((t) => isRecord(t) && t.type === tool.type);

  // Responses Lite moves tools into an `additional_tools` input item.
  if (!Array.isArray(body.tools) && Array.isArray(body.input)) {
    const holder = body.input.find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools),
    );
    if (holder) {
      const tools = holder.tools as unknown[];
      if (!has(tools)) holder.tools = [...tools, { ...tool }];
      return body;
    }
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  return has(tools) ? body : { ...body, tools: [...tools, { ...tool }] };
}

/**
 * Wrap pi-ai stream options so the request carries the provider's web search
 * tool. Runs after any existing onPayload (adaptive thinking, Responses Lite).
 */
export function withPiAiNativeWebSearch<T extends { onPayload?: OnPayload }>(
  provider: NativeSearchProvider,
  options: T,
): T {
  const inner = options.onPayload;
  return {
    ...options,
    onPayload: async (params: any, model: unknown) => {
      const patched = inner ? await inner(params, model) : undefined;
      const body = (patched ?? params) as Record<string, unknown>;
      return addNativeWebSearchToPayload(provider, body);
    },
  };
}
