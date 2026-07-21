import { describe, expect, test } from "vitest";
import { orchestrateModelStream } from "../src/gateway/services/agent/streamOrchestrator.js";

async function* chunkStream(
  chunks: unknown[],
): AsyncGenerator<unknown, void, void> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("agent stream orchestrator", () => {
  test("streams text/reasoning and returns aggregated state", async () => {
    const chunks = [
      { type: "text-delta", text: "hello " },
      { type: "reasoning-delta", text: "think " },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "echo ok" },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "bash",
        output: "ok",
      },
      { type: "text-delta", text: "world" },
      { type: "reasoning-end" },
      { type: "finish" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-1", []);
    const emittedTypes: string[] = [];
    let finalState:
      | {
          assistantText: string;
          thinkingText: string;
          toolCalls: Array<{ toolCallId: string }>;
          toolResults: Array<{ toolCallId: string }>;
        }
      | undefined;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
      emittedTypes.push(next.value.type);
    }

    expect(emittedTypes).toContain("text-delta");
    expect(emittedTypes).toContain("reasoning-delta");
    expect(emittedTypes).toContain("tool-call");
    expect(emittedTypes).toContain("tool-result");
    expect(finalState?.assistantText).toBe("hello world");
    expect(finalState?.thinkingText).toBe("think ");
    expect(finalState?.toolCalls).toHaveLength(1);
    expect(finalState?.toolResults).toHaveLength(1);
  });

  test("emits sanitized tool-error and stream error chunks", async () => {
    const chunks = [
      {
        type: "tool-error",
        toolCallId: "call-err",
        toolName: "read_file",
        error: "failed with secret sk-abc12345678901234567890",
      },
      {
        type: "error",
        error: "fatal with token sk-xyz12345678901234567890",
      },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-2", [
      "sk-abc12345678901234567890",
      "sk-xyz12345678901234567890",
    ]);
    const emitted: Array<{ type: string; payload: unknown }> = [];

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      emitted.push({ type: next.value.type, payload: next.value.payload });
    }

    const toolError = emitted.find((entry) => entry.type === "tool-error");
    const streamError = emitted.find((entry) => entry.type === "error");

    expect(toolError).toBeDefined();
    expect(streamError).toBeDefined();
    expect(JSON.stringify(toolError?.payload)).not.toContain(
      "sk-abc12345678901234567890",
    );
    expect(JSON.stringify(streamError?.payload)).not.toContain(
      "sk-xyz12345678901234567890",
    );
  });

  test("formats Papr proxy connect timeout errors clearly", async () => {
    const connectTimeoutError = {
      name: "AI_RetryError",
      reason: "maxRetriesExceeded",
      errors: [
        {
          name: "AI_APICallError",
          cause: {
            name: "ConnectTimeoutError",
            code: "UND_ERR_CONNECT_TIMEOUT",
          },
          url: "https://memory.papr.ai/v1/ai/zai/chat/completions",
        },
      ],
      lastError: {
        name: "AI_APICallError",
        cause: {
          name: "ConnectTimeoutError",
          code: "UND_ERR_CONNECT_TIMEOUT",
        },
        url: "https://memory.papr.ai/v1/ai/zai/chat/completions",
      },
    };

    const iterator = orchestrateModelStream(
      chunkStream([{ type: "error", error: connectTimeoutError }]),
      "chat-3",
      [],
    );
    const emitted: Array<{ type: string; payload: unknown }> = [];

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      emitted.push({ type: next.value.type, payload: next.value.payload });
    }

    const streamError = emitted.find((entry) => entry.type === "error");
    expect(streamError).toBeDefined();

    const payload = streamError?.payload as { error?: string };
    expect(payload.error).toContain("Could not connect to Papr's AI service");
    expect(payload.error).toContain("timed out after several retries");
    expect(payload.error).not.toContain("requestBodyValues");
    expect(payload.error).not.toContain("AI_RetryError");
  });
});
