import { describe, expect, test, beforeEach } from "vitest";
import type { StoredMessage } from "../src/gateway/services/storage/IStorageProvider.js";
import {
  findFullToolResult,
  sliceToolResult,
} from "../src/gateway/services/agent/toolResultLookup.js";
import {
  clearInFlightToolResults,
  recordInFlightToolResult,
  resetInFlightToolResultsForTests,
} from "../src/gateway/services/agent/inFlightToolResults.js";

describe("toolResultLookup", () => {
  beforeEach(() => {
    resetInFlightToolResultsForTests();
  });

  test("finds in-flight tool results before SQLite checkpoint", async () => {
    recordInFlightToolResult("chat-1", "toolu_abc", "list_job_files", {
      items: ["a", "b"],
    });

    const match = await findFullToolResult({
      chatIds: ["chat-1"],
      toolCallId: "toolu_abc",
      loadMessages: async () => [],
    });

    expect(match).toMatchObject({
      chatId: "chat-1",
      toolName: "list_job_files",
      messageId: "in-flight",
    });
    expect(match?.result).toContain('"items"');
  });

  test("finds in-flight tool results with normalized tool call ids", async () => {
    recordInFlightToolResult("chat-1", "toolu@abc#123", "bash", "hello");

    const match = await findFullToolResult({
      chatIds: ["chat-1"],
      toolCallId: "toolu_abc_123",
      loadMessages: async () => [],
    });

    expect(match?.result).toBe("hello");
  });

  test("finds persisted toolCalls by id", async () => {
    const messages: StoredMessage[] = [
      {
        id: "msg-1",
        chat_id: "chat-1",
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        toolCalls: [
          {
            id: "toolu_xyz",
            name: "read_app_file",
            result: "full file contents here",
          },
        ],
      },
    ];

    const match = await findFullToolResult({
      chatIds: ["chat-1"],
      toolCallId: "toolu_xyz",
      loadMessages: async () => messages,
    });

    expect(match?.result).toBe("full file contents here");
  });

  test("finds tool results stored only on sequence entries", async () => {
    const messages: StoredMessage[] = [
      {
        id: "msg-2",
        chat_id: "chat-1",
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        sequence: [
          {
            type: "tool",
            data: {
              toolCallId: "toolu_seq",
              name: "bash",
              output: "hello from bash",
            },
          },
        ],
      },
    ];

    const match = await findFullToolResult({
      chatIds: ["chat-1"],
      toolCallId: "toolu_seq",
      loadMessages: async () => messages,
    });

    expect(match?.result).toBe("hello from bash");
  });

  test("sliceToolResult paginates large payloads", () => {
    const full = "abcdefghij";
    const page = sliceToolResult(full, 2, 4);
    expect(page.result).toBe("cdef");
    expect(page.hasMore).toBe(true);
    expect(page.nextStartChar).toBe(6);
  });

  test("clearInFlightToolResults removes cached turn data", async () => {
    recordInFlightToolResult("chat-1", "toolu_temp", "bash", "output");
    clearInFlightToolResults("chat-1");

    const match = await findFullToolResult({
      chatIds: ["chat-1"],
      toolCallId: "toolu_temp",
      loadMessages: async () => [],
    });

    expect(match).toBeNull();
  });
});
