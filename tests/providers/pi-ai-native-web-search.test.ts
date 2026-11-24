import { describe, expect, it } from "vitest";
import {
  addNativeWebSearchToPayload,
  withPiAiNativeWebSearch,
} from "../../src/gateway/services/providers/piAiNativeWebSearch.js";
import { augmentPiAiCodexStreamOptions } from "../../src/gateway/services/providers/piAiCodexResponsesLite.js";
import { buildPiContext } from "../../src/gateway/services/providers/piAiHelpers.js";

describe("pi-ai native web search", () => {
  it("adds Anthropic's server tool next to function tools", () => {
    const body = addNativeWebSearchToPayload("anthropic", {
      tools: [{ name: "Bash", input_schema: { type: "object" } }],
    });
    expect(body.tools).toEqual([
      { name: "Bash", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ]);
  });

  it("adds the hosted tool for ChatGPT when there are no tools yet", () => {
    expect(addNativeWebSearchToPayload("openai-codex", { input: [] }).tools).toEqual([
      { type: "web_search" },
    ]);
  });

  it("does not add it twice", () => {
    const once = addNativeWebSearchToPayload("anthropic", {});
    expect(addNativeWebSearchToPayload("anthropic", once).tools).toHaveLength(1);
  });

  it("runs after an existing onPayload (adaptive thinking)", async () => {
    const opts = withPiAiNativeWebSearch("anthropic", {
      onPayload: (p: any) => ({ ...p, thinking: { type: "adaptive" } }),
    });
    const out = (await opts.onPayload!({ model: "m", tools: [] }, {})) as any;
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  });

  it("lands inside additional_tools on Responses Lite models", async () => {
    const lite = augmentPiAiCodexStreamOptions("gpt-5.6-luna", { apiKey: "k", sessionId: "s" });
    const opts = withPiAiNativeWebSearch("openai-codex", lite);
    const out = (await opts.onPayload!(
      { input: [{ role: "user", content: "hi" }], tools: [{ type: "function", name: "f" }] },
      {},
    )) as any;
    expect(out.tools).toBeUndefined();
    expect(out.input[0]).toMatchObject({ type: "additional_tools" });
    expect(out.input[0].tools).toEqual([{ type: "function", name: "f" }, { type: "web_search" }]);
  });

  it("is never passed to pi-ai as a function tool", () => {
    const ctx = buildPiContext({
      messages: [{ role: "user", content: "hi" }] as any,
      tools: {},
      apiId: "anthropic-messages",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(ctx.tools).toBeUndefined();
  });
});
