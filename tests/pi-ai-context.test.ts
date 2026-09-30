import { describe, expect, test } from "vitest";
import { buildPiContext } from "../src/gateway/services/providers/piAiHelpers.js";

describe("buildPiContext", () => {
  test("preserves AI SDK 6 tool-result output from stored history", () => {
    const { messages } = buildPiContext({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "/tmp/example.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read_file",
              output: { type: "text", value: "file body from prior turn" },
            },
          ],
        },
      ],
      tools: {},
      apiId: "anthropic-messages",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const toolCallPart = (assistant as { content: Array<{ type: string; arguments?: Record<string, unknown> }> })
      .content.find((part) => part.type === "toolCall");
    expect(toolCallPart?.arguments).toEqual({ path: "/tmp/example.txt" });

    const toolResult = messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect((toolResult as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "file body from prior turn",
    );
  });

  test("does not emit orphan marker when output field carries JSON result", () => {
    const { messages } = buildPiContext({
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_2",
              toolName: "bash",
              output: { type: "json", value: { success: true, stdout: "ok" } },
            },
          ],
        },
      ],
      tools: {},
      apiId: "openai-codex-responses",
      providerId: "openai-codex",
      modelId: "gpt-5.4",
    });

    const toolResult = messages.find((m) => m.role === "toolResult");
    expect((toolResult as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      '{"success":true,"stdout":"ok"}',
    );
  });

  test("passes user image parts through to pi-ai ImageContent", () => {
    const { messages } = buildPiContext({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this screenshot" },
            {
              type: "image",
              image: "abc123",
              mediaType: "image/png",
            },
          ],
        },
      ],
      tools: {},
      apiId: "openai-codex-responses",
      providerId: "openai-codex",
      modelId: "gpt-5.4",
    });

    const user = messages.find((m) => m.role === "user");
    expect(user).toBeDefined();
    expect(Array.isArray((user as { content: unknown }).content)).toBe(true);
    const parts = (user as { content: Array<{ type: string; data?: string; mimeType?: string }> })
      .content;
    expect(parts).toEqual([
      { type: "text", text: "Describe this screenshot" },
      { type: "image", data: "abc123", mimeType: "image/png" },
    ]);
  });
});
