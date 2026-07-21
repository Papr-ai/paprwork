import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import {
  EMPTY_PI_AI_BILLING_USAGE,
  accumulatePiAiBillingUsage,
  extractPiAiUsageFromDoneEvent,
  getPiAiContextTokensFromStep,
} from "../src/gateway/services/providers/piAiUsage.js";

function makeDoneEvent(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): AssistantMessageEvent {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        ...usage,
        totalTokens:
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

describe("piAiUsage", () => {
  it("extracts usage from event.message.usage (not top-level event.usage)", () => {
    const event = makeDoneEvent({
      input: 1000,
      output: 200,
      cacheRead: 50000,
      cacheWrite: 8000,
    });

    expect(extractPiAiUsageFromDoneEvent(event)).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 59200,
      cacheReadTokens: 50000,
      cacheWriteTokens: 8000,
    });
  });

  it("accumulates multi-step billing across tool loop steps", () => {
    const step1 = extractPiAiUsageFromDoneEvent(
      makeDoneEvent({
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 5000,
      }),
    )!;
    const step2 = extractPiAiUsageFromDoneEvent(
      makeDoneEvent({
        input: 500,
        output: 300,
        cacheRead: 45000,
        cacheWrite: 0,
      }),
    )!;

    const total = accumulatePiAiBillingUsage(
      accumulatePiAiBillingUsage(EMPTY_PI_AI_BILLING_USAGE, step1),
      step2,
    );

    expect(total).toEqual({
      promptTokens: 1500,
      completionTokens: 400,
      totalTokens: 51900,
      cacheReadTokens: 45000,
      cacheWriteTokens: 5000,
    });
  });

  it("computes context size from input + cache tokens", () => {
    const step = extractPiAiUsageFromDoneEvent(
      makeDoneEvent({
        input: 1000,
        output: 200,
        cacheRead: 50000,
        cacheWrite: 8000,
      }),
    )!;

    expect(getPiAiContextTokensFromStep(step)).toBe(59000);
  });
});
