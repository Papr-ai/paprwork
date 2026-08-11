import { describe, expect, test } from "vitest";
import type { StoredMessage } from "../src/gateway/services/storage/IStorageProvider.js";
import {
  buildPaprSyncContent,
  buildPaprSyncStoreBody,
  isJobSessionChatId,
  measurePaprStoreBodyBytes,
  PAPR_SYNC_MAX_BYTES,
  resetJobSessionProcessThrottleForTests,
  truncateStringForPaprSync,
} from "../src/gateway/services/storage/paprSyncPayload.js";

function makeToolCall(
  index: number,
  args: Record<string, unknown>,
  result?: string,
): NonNullable<StoredMessage["toolCalls"]>[number] {
  return {
    id: `tool-${index}`,
    name: "bash",
    args,
    result,
  };
}

function makeHeavyMessage(toolCount: number): StoredMessage {
  const longCommand = "echo " + "x".repeat(18_000);
  return {
    id: "msg-heavy",
    chat_id: "chat-1",
    role: "assistant",
    content: "Done reviewing the app files.",
    timestamp: "2026-07-22T11:05:13.033Z",
    thinking: "t".repeat(4_000),
    sync_status: "sync_pending",
    toolCalls: Array.from({ length: toolCount }, (_, i) =>
      makeToolCall(i, { command: longCommand }, "ok"),
    ),
    prompt_tokens: 120_000,
    completion_tokens: 8_000,
    total_tokens: 128_000,
    model: "gpt-5.4",
  };
}

describe("paprSyncPayload", () => {
  test("truncateStringForPaprSync adds marker when shortening", () => {
    const out = truncateStringForPaprSync("abcdefghij".repeat(20), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("truncated for cloud sync");
  });

  test("buildPaprSyncContent omits thinking by default", () => {
    const blocks = buildPaprSyncContent(
      {
        role: "assistant",
        content: "hello",
        thinking: "secret reasoning",
        toolCalls: [makeToolCall(0, { command: "ls" }, "files")],
      },
      {
        maxTextChars: 8_000,
        maxToolArgsChars: 500,
        maxToolResultChars: 500,
        includeThinking: false,
        includeToolInputs: true,
        includeToolResults: true,
      },
    );

    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;
    expect(blocks.some((b) => b.type === "thinking")).toBe(false);
    expect(blocks.some((b) => b.type === "tool_use")).toBe(true);
  });

  test("buildPaprSyncContent truncates large bash args", () => {
    const blocks = buildPaprSyncContent(
      {
        role: "assistant",
        content: "running",
        toolCalls: [makeToolCall(0, { command: "c".repeat(10_000) }, "ok")],
      },
      {
        maxTextChars: 8_000,
        maxToolArgsChars: 500,
        maxToolResultChars: 500,
        includeThinking: false,
        includeToolInputs: true,
        includeToolResults: true,
      },
    );

    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;
    const toolUse = blocks.find((b) => b.type === "tool_use");
    expect(toolUse?.type).toBe("tool_use");
    if (toolUse?.type !== "tool_use") return;
    const preview = toolUse.input?._truncatedPreview;
    expect(typeof preview).toBe("string");
    if (typeof preview !== "string") return;
    expect(preview.length).toBeLessThanOrEqual(500);
  });

  test("28 heavy bash tool calls stay under PAPR_SYNC_MAX_BYTES", () => {
    const body = buildPaprSyncStoreBody({
      chatId: "582a2781-8091-474b-9300-d63574006442",
      message: makeHeavyMessage(28),
      externalUserId: "user-abc",
    });

    expect(measurePaprStoreBodyBytes(body)).toBeLessThanOrEqual(
      PAPR_SYNC_MAX_BYTES,
    );
    expect(body.metadata.customMetadata.toolCallsCount).toBe(28);
    expect(body.metadata.customMetadata.hasThinking).toBe(true);
    expect(body.metadata.customMetadata.thinkingLength).toBe(4_000);
  });

  test("extreme payloads fall back to summary text", () => {
    const body = buildPaprSyncStoreBody({
      chatId: "chat-1",
      message: makeHeavyMessage(200),
      maxBytes: 2_000,
    });

    expect(typeof body.content).toBe("string");
    expect(body.content).toContain("tool calls");
    expect(body.content).toContain("stored locally");
    expect(body.metadata.customMetadata.syncPayloadTruncated).toBe(true);
    expect(measurePaprStoreBodyBytes(body)).toBeLessThanOrEqual(2_000);
  });

  test("job session enables process_messages on first sync then throttles", () => {
    resetJobSessionProcessThrottleForTests();

    const jobId = "793f8eeb-ddd8-4b0d-9671-9e813488c9bf";
    const chatId1 = `job:${jobId}:${jobId}-1786338017643-a1`;
    const chatId2 = `job:${jobId}:${jobId}-1786338017644-a1`;

    expect(isJobSessionChatId(chatId1)).toBe(true);

    const message = {
      id: "msg-job",
      chat_id: chatId1,
      role: "user" as const,
      content: "=== JOB ENVIRONMENT ===",
      timestamp: "2026-08-10T05:00:23.422Z",
      sync_status: "sync_pending" as const,
    };

    expect(
      buildPaprSyncStoreBody({ chatId: chatId1, message }).process_messages,
    ).toBe(true);
    expect(
      buildPaprSyncStoreBody({ chatId: chatId2, message: { ...message, chat_id: chatId2 } })
        .process_messages,
    ).toBe(false);
    expect(buildPaprSyncStoreBody({ chatId: chatId1, message }).sessionId).toBe(
      chatId1,
    );
  });

  test("human chat ids keep process_messages enabled", () => {
    const body = buildPaprSyncStoreBody({
      chatId: "582a2781-8091-474b-9300-d63574006442",
      message: {
        id: "msg-human",
        chat_id: "582a2781-8091-474b-9300-d63574006442",
        role: "user",
        content: "hello",
        timestamp: "2026-08-10T05:00:23.422Z",
        sync_status: "sync_pending",
      },
    });

    expect(body.process_messages).toBe(true);
  });

  test("processMessages override can re-enable job session processing", () => {
    const jobId = "793f8eeb-ddd8-4b0d-9671-9e813488c9bf";
    const chatId = `job:${jobId}:${jobId}-1786338017643-a1`;

    const body = buildPaprSyncStoreBody({
      chatId,
      processMessages: true,
      message: {
        id: "msg-job",
        chat_id: chatId,
        role: "user",
        content: "force processing",
        timestamp: "2026-08-10T05:00:23.422Z",
        sync_status: "sync_pending",
      },
    });

    expect(body.process_messages).toBe(true);
  });
});
