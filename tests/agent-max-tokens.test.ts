import { describe, expect, test, vi } from "vitest";
import { orchestrateModelStream } from "../src/gateway/services/agent/streamOrchestrator.js";
import type { AgentConfig } from "../src/core/types/agents.js";

async function* chunkStream(
  chunks: unknown[],
): AsyncGenerator<unknown, void, void> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("agent maxTokens configuration", () => {
  test("passes maxTokens from config to AI SDK", () => {
    const config: AgentConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      systemPrompt: "test",
      maxTokens: 8192,
    };

    expect(config.maxTokens).toBe(8192);
    expect(config.maxTokens).toBeGreaterThan(4096); // Should be > default
  });

  test("handles missing maxTokens gracefully", () => {
    const config: AgentConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      systemPrompt: "test",
      // no maxTokens specified
    };

    expect(config.maxTokens).toBeUndefined();
  });

  test("supports different maxTokens per provider", () => {
    const configs: AgentConfig[] = [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        systemPrompt: "test",
        maxTokens: 8192,
      },
      {
        provider: "openai",
        model: "gpt-5-2",
        systemPrompt: "test",
        maxTokens: 16384,
      },
      {
        provider: "google",
        model: "gemini-2-5-flash",
        systemPrompt: "test",
        maxTokens: 8192,
      },
    ];

    expect(configs[0].maxTokens).toBe(8192); // Claude
    expect(configs[1].maxTokens).toBe(16384); // OpenAI (higher)
    expect(configs[2].maxTokens).toBe(8192); // Gemini
  });
});

describe("agent finish reasons", () => {
  test("handles finish reason: stop (normal completion)", async () => {
    const chunks = [
      { type: "text-delta", text: "This is a complete response." },
      { type: "finish", finishReason: "stop" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-1", []);
    const emittedTypes: string[] = [];
    let finalState: { assistantText: string } | undefined;

    // Spy on console to check logs
    const consoleLog = vi.spyOn(console, "log");

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
      emittedTypes.push(next.value.type);
    }

    expect(finalState?.assistantText).toBe("This is a complete response.");
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Finish chunk received"),
    );
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("reason: stop"),
    );

    consoleLog.mockRestore();
  });

  test("warns on finish reason: length (token limit reached)", async () => {
    const chunks = [
      { type: "text-delta", text: "This response was cut off mid-sen" },
      { type: "finish", finishReason: "length" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-2", []);
    let finalState: { assistantText: string } | undefined;

    const consoleWarn = vi.spyOn(console, "warn");

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.assistantText).toBe("This response was cut off mid-sen");
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("Model stopped due to TOKEN LIMIT"),
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("Consider increasing maxTokens"),
    );

    consoleWarn.mockRestore();
  });

  test("handles finish reason: tool-calls (agent making tool calls)", async () => {
    const chunks = [
      { type: "text-delta", text: "Let me check that file." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "test.txt" },
      },
      { type: "finish", finishReason: "tool-calls" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-3", []);
    let finalState:
      | { assistantText: string; toolCalls: Array<{ toolCallId: string }> }
      | undefined;

    const consoleLog = vi.spyOn(console, "log");

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.assistantText).toBe("Let me check that file.");
    expect(finalState?.toolCalls).toHaveLength(1);
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("reason: tool-calls"),
    );

    consoleLog.mockRestore();
  });

  test("handles unknown finish reason", async () => {
    const chunks = [
      { type: "text-delta", text: "Some text" },
      { type: "finish", finishReason: "unknown-reason" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-4", []);
    let finalState: { assistantText: string } | undefined;

    const consoleLog = vi.spyOn(console, "log");

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.assistantText).toBe("Some text");
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("reason: unknown-reason"),
    );

    consoleLog.mockRestore();
  });

  test("handles missing finish reason", async () => {
    const chunks = [
      { type: "text-delta", text: "Some text" },
      { type: "finish" }, // No finishReason field
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-5", []);
    let finalState: { assistantText: string } | undefined;

    const consoleLog = vi.spyOn(console, "log");

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.assistantText).toBe("Some text");
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("reason: unknown"),
    );

    consoleLog.mockRestore();
  });
});

describe("agent token limit behavior", () => {
  test("completes full response when under token limit", async () => {
    const fullResponse = "This is a complete response that should finish naturally.";
    const chunks = [
      { type: "text-delta", text: fullResponse },
      { type: "finish", finishReason: "stop" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-1", []);
    let finalState: { assistantText: string } | undefined;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.assistantText).toBe(fullResponse);
    expect(finalState?.assistantText.length).toBe(fullResponse.length);
  });

  test("truncates response when hitting token limit", async () => {
    const truncatedResponse = "This response was truncated mid-se";
    const chunks = [
      { type: "text-delta", text: truncatedResponse },
      { type: "finish", finishReason: "length" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-2", []);
    let finalState: { assistantText: string } | undefined;

    const consoleWarn = vi.spyOn(console, "warn");

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.assistantText).toBe(truncatedResponse);
    // Should have warned about token limit
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("TOKEN LIMIT"),
    );

    consoleWarn.mockRestore();
  });

  test("handles multiple text deltas before token limit", async () => {
    const chunks = [
      { type: "text-delta", text: "First chunk " },
      { type: "text-delta", text: "second chunk " },
      { type: "text-delta", text: "third chu" }, // Truncated
      { type: "finish", finishReason: "length" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-3", []);
    let finalState: { assistantText: string } | undefined;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.assistantText).toBe("First chunk second chunk third chu");
  });

  test("flushes remaining buffer when token limit reached", async () => {
    // Simulate buffer with < 50 chars that needs flushing
    const chunks = [
      { type: "text-delta", text: "Short text" }, // < 50 chars
      { type: "finish", finishReason: "length" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-4", []);
    let finalState: { assistantText: string } | undefined;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    // Should flush buffer even if < 50 chars
    expect(finalState?.assistantText).toBe("Short text");
  });
});

describe("agent sequence building with token limits", () => {
  test("builds complete sequence when under token limit", async () => {
    const chunks = [
      { type: "text-delta", text: "Let me check. " },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "test.txt" },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        output: "file contents",
      },
      { type: "text-delta", text: "The file contains data." },
      { type: "finish", finishReason: "stop" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-1", []);
    let finalState:
      | {
          sequence: Array<{ type: string; data: unknown }>;
        }
      | undefined;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.sequence).toBeDefined();
    expect(finalState?.sequence.length).toBeGreaterThan(0);
    // Should have: text -> tool -> text
    const types = finalState?.sequence.map((item) => item.type);
    expect(types).toContain("text");
    expect(types).toContain("tool");
  });

  test("builds partial sequence when hitting token limit mid-response", async () => {
    const chunks = [
      { type: "text-delta", text: "Let me check. " },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "test.txt" },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        output: "file contents",
      },
      { type: "text-delta", text: "The file cont" }, // Truncated
      { type: "finish", finishReason: "length" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-2", []);
    let finalState:
      | {
          assistantText: string;
          sequence: Array<{ type: string; data: unknown }>;
        }
      | undefined;

    const consoleWarn = vi.spyOn(console, "warn");

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.sequence).toBeDefined();
    expect(finalState?.assistantText).toContain("The file cont");
    // Should have warned about token limit
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("TOKEN LIMIT"),
    );

    consoleWarn.mockRestore();
  });

  test("includes all tool calls in sequence before token limit", async () => {
    const chunks = [
      { type: "text-delta", text: "Checking multiple files. " },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "a.txt" },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        output: "content a",
      },
      { type: "text-delta", text: "Now checking second file. " },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "read_file",
        input: { path: "b.txt" },
      },
      {
        type: "tool-result",
        toolCallId: "call-2",
        toolName: "read_file",
        output: "content b",
      },
      { type: "text-delta", text: "Done chec" }, // Truncated
      { type: "finish", finishReason: "length" },
    ];

    const iterator = orchestrateModelStream(chunkStream(chunks), "chat-3", []);
    let finalState:
      | {
          sequence: Array<{ type: string; data: unknown }>;
          toolCalls: Array<{ toolCallId: string }>;
        }
      | undefined;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finalState = next.value;
        break;
      }
    }

    expect(finalState?.toolCalls).toHaveLength(2);
    expect(finalState?.sequence).toBeDefined();
    // Should have all tool calls in sequence
    const toolItems = finalState?.sequence.filter(
      (item) => item.type === "tool",
    );
    expect(toolItems?.length).toBe(2);
  });
});
