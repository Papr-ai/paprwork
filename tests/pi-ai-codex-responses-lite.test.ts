/**
 * Codex Responses Lite — GPT-5.6 OAuth transport fix
 */

import { describe, it, expect } from "vitest";
import {
  requiresCodexResponsesLite,
  transformToResponsesLite,
  augmentPiAiCodexStreamOptions,
  CODEX_RESPONSES_LITE_HEADER,
  CODEX_COMPATIBILITY_VERSION,
} from "../src/gateway/services/providers/piAiCodexResponsesLite.js";

describe("requiresCodexResponsesLite", () => {
  it("returns true only for Luna", () => {
    expect(requiresCodexResponsesLite("gpt-5-6-luna")).toBe(true);
    expect(requiresCodexResponsesLite("gpt-5.6-luna")).toBe(true);
  });

  it("returns false for Sol and Terra (standard OAuth transport)", () => {
    expect(requiresCodexResponsesLite("gpt-5.6-sol")).toBe(false);
    expect(requiresCodexResponsesLite("gpt-5-6-sol")).toBe(false);
    expect(requiresCodexResponsesLite("gpt-5.6-sol-low")).toBe(false);
    expect(requiresCodexResponsesLite("gpt-5-6-terra")).toBe(false);
    expect(requiresCodexResponsesLite("gpt-5.6")).toBe(false);
  });

  it("returns false for older GPT models", () => {
    expect(requiresCodexResponsesLite("gpt-5.4")).toBe(false);
    expect(requiresCodexResponsesLite("gpt-5.5")).toBe(false);
    expect(requiresCodexResponsesLite("gpt-5.3-codex")).toBe(false);
  });
});

describe("transformToResponsesLite", () => {
  it("rewrites tools and instructions into input array", () => {
    const codexSessionId = "019f4860-9ca3-7000-81e9-08939c58b0fa";
    const body = {
      model: "gpt-5.6-luna",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,test",
              detail: "high",
            },
          ],
        },
      ],
      instructions: "Be concise.",
      tools: [
        {
          type: "function",
          name: "noop",
          description: "No operation",
          parameters: { type: "object", properties: {} },
        },
      ],
      parallel_tool_calls: true,
      prompt_cache_key: "old-key",
      reasoning: { effort: "high", summary: "auto" },
      stream: true,
    };

    const result = transformToResponsesLite(body, codexSessionId);

    expect(result.tools).toBeUndefined();
    expect(result.instructions).toBeUndefined();
    expect(result.tool_choice).toBe("auto");
    expect(result.parallel_tool_calls).toBe(false);
    expect(result.prompt_cache_key).toBe(codexSessionId);
    expect(result.reasoning).toEqual({
      effort: "high",
      summary: "auto",
      context: "all_turns",
    });
    expect(result.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: body.tools,
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Be concise." }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,test",
          },
        ],
      },
    ]);
  });

  it("handles empty tools and no instructions", () => {
    const result = transformToResponsesLite(
      {
        model: "gpt-5.6-luna",
        input: [],
        stream: true,
      },
      "session-abc",
    );

    expect(result.input).toEqual([
      { type: "additional_tools", role: "developer", tools: [] },
    ]);
  });
});

describe("augmentPiAiCodexStreamOptions", () => {
  it("adds Responses Lite headers and onPayload for Luna", async () => {
    const augmented = augmentPiAiCodexStreamOptions("gpt-5.6-luna", {
      apiKey: "token",
      sessionId: "chat-session-1",
    });

    expect(augmented.headers?.[CODEX_RESPONSES_LITE_HEADER]).toBe("true");
    expect(augmented.headers?.version).toBe(CODEX_COMPATIBILITY_VERSION);
    expect(augmented.headers?.["session-id"]).toBe(augmented.sessionId);
    expect(augmented.headers?.["x-session-affinity"]).toBe(augmented.sessionId);
    expect(augmented.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const transformed = await augmented.onPayload?.(
      {
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
        instructions: "System",
        tools: [],
      },
      {},
    );

    expect(transformed?.tools).toBeUndefined();
    expect(transformed?.prompt_cache_key).toBe(augmented.sessionId);
  });

  it("reuses codex session id for same source session", () => {
    const first = augmentPiAiCodexStreamOptions("gpt-5.6-luna", {
      apiKey: "token",
      sessionId: "same-chat",
    });
    const second = augmentPiAiCodexStreamOptions("gpt-5.6-luna", {
      apiKey: "token",
      sessionId: "same-chat",
    });

    expect(first.sessionId).toBe(second.sessionId);
  });

  it("passes through Sol unchanged (no Responses Lite)", () => {
    const base = { apiKey: "token", sessionId: "chat-1" };
    expect(augmentPiAiCodexStreamOptions("gpt-5.6-sol", base)).toBe(base);
    expect(augmentPiAiCodexStreamOptions("gpt-5.4", base)).toBe(base);
  });
});
