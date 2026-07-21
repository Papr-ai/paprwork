import { describe, expect, it } from "vitest";
import {
  adaptGroqAISDKFullStream,
  extractGroqReasoningDelta,
  injectGroqReasoningRequestBody,
} from "../src/gateway/utils/groqProvider.js";

describe("groqProvider", () => {
  it("injects reasoning_format parsed for Qwen models", () => {
    const body: Record<string, unknown> = { model: "qwen/qwen3-32b" };
    injectGroqReasoningRequestBody(body, "qwen/qwen3-32b");
    expect(body.reasoning_format).toBe("parsed");
    expect(body.reasoning_effort).toBe("default");
  });

  it("injects include_reasoning for GPT-OSS models", () => {
    const body: Record<string, unknown> = { model: "openai/gpt-oss-120b" };
    injectGroqReasoningRequestBody(body, "openai/gpt-oss-120b");
    expect(body.include_reasoning).toBe(true);
    expect(body.reasoning_format).toBeUndefined();
  });

  it("extracts reasoning delta from raw Groq SSE chunk", () => {
    const raw = {
      choices: [{ delta: { reasoning: "Let me think..." } }],
    };
    expect(extractGroqReasoningDelta(raw)).toBe("Let me think...");
    expect(extractGroqReasoningDelta({ choices: [{ delta: {} }] })).toBeNull();
  });

  it("adaptGroqAISDKFullStream emits reasoning-delta from raw chunks", async () => {
    async function* source() {
      yield {
        type: "raw",
        rawValue: { choices: [{ delta: { reasoning: "step 1" } }] },
      };
      yield { type: "text-delta", text: "Answer" };
    }

    const chunks: Array<{ type?: string; text?: string }> = [];
    for await (const chunk of adaptGroqAISDKFullStream(source())) {
      if (typeof chunk === "object" && chunk !== null && "type" in chunk) {
        chunks.push(chunk as { type?: string; text?: string });
      }
    }

    expect(chunks.some((c) => c.type === "reasoning-start")).toBe(true);
    expect(chunks.some((c) => c.type === "reasoning-delta" && c.text === "step 1")).toBe(
      true,
    );
    expect(chunks.some((c) => c.type === "reasoning-end")).toBe(true);
    expect(chunks.some((c) => c.type === "text-delta" && c.text === "Answer")).toBe(
      true,
    );
  });
});
