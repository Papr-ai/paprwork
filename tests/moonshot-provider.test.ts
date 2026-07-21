import { describe, expect, it } from "vitest";
import {
  adaptMoonshotAISDKFullStream,
  extractMoonshotReasoningDelta,
  injectMoonshotRequestBody,
} from "../src/gateway/utils/moonshotProvider.js";
import { normalizeMoonshotModelId } from "../src/gateway/utils/moonshotModel.js";

describe("moonshotModel", () => {
  it("normalizes kimi-3 alias to kimi-k3", () => {
    expect(normalizeMoonshotModelId("kimi-3")).toBe("kimi-k3");
    expect(normalizeMoonshotModelId("kimi-k3")).toBe("kimi-k3");
  });
});

describe("moonshotProvider", () => {
  it("injects reasoning_effort max and strips fixed sampling params", () => {
    const body: Record<string, unknown> = {
      model: "kimi-k3",
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0.1,
    };
    injectMoonshotRequestBody(body);
    expect(body.reasoning_effort).toBe("max");
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
  });

  it("extracts reasoning_content delta from raw Moonshot SSE chunk", () => {
    const raw = {
      choices: [{ delta: { reasoning_content: "Let me think..." } }],
    };
    expect(extractMoonshotReasoningDelta(raw)).toBe("Let me think...");
    expect(extractMoonshotReasoningDelta({ choices: [{ delta: {} }] })).toBeNull();
  });

  it("adaptMoonshotAISDKFullStream emits reasoning-delta from raw chunks", async () => {
    async function* source() {
      yield {
        type: "raw",
        rawValue: {
          choices: [{ delta: { reasoning_content: "step 1" } }],
        },
      };
      yield { type: "text-delta", text: "Answer" };
    }

    const chunks: Array<{ type?: string; text?: string }> = [];
    for await (const chunk of adaptMoonshotAISDKFullStream(source())) {
      if (typeof chunk === "object" && chunk !== null && "type" in chunk) {
        chunks.push(chunk as { type?: string; text?: string });
      }
    }

    expect(chunks.some((c) => c.type === "reasoning-start")).toBe(true);
    expect(
      chunks.some((c) => c.type === "reasoning-delta" && c.text === "step 1"),
    ).toBe(true);
    expect(chunks.some((c) => c.type === "reasoning-end")).toBe(true);
    expect(chunks.some((c) => c.type === "text-delta" && c.text === "Answer")).toBe(
      true,
    );
  });
});
