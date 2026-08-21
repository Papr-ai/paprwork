import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_ROW_PAYLOAD_CHARS,
  OFFLOAD_PREVIEW_CHARS,
  OFFLOAD_THRESHOLD_CHARS,
  findOffloadRef,
  readOffloadedResult,
  restoreSequencePayloads,
  serializeMessagePayloads,
  deleteChatSidecars,
  SIDECAR_DIRNAME,
} from "../src/gateway/services/storage/messagePayloadStore.js";
import type { StoredMessage } from "../src/gateway/services/storage/IStorageProvider.js";

let dbDir: string;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "payload-store-"));
});

afterEach(() => {
  fs.rmSync(dbDir, { recursive: true, force: true });
});

/** Round-trips a message through storage the way LocalStorageProvider does. */
function roundTrip(message: StoredMessage): StoredMessage {
  const { toolCallsJson, sequenceJson } = serializeMessagePayloads({
    dbDir,
    chatId: "chat-1",
    messageId: "msg-1",
    message,
  });

  const toolCalls = toolCallsJson ? JSON.parse(toolCallsJson) : undefined;
  const sequence = sequenceJson ? JSON.parse(sequenceJson) : undefined;

  return {
    ...message,
    toolCalls,
    sequence: restoreSequencePayloads(sequence, toolCalls),
  } as StoredMessage;
}

function baseMessage(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: "msg-1",
    role: "assistant",
    content: "done",
    timestamp: new Date().toISOString(),
    ...overrides,
  } as StoredMessage;
}

describe("serializeMessagePayloads", () => {
  it("restores a small message byte-for-byte", () => {
    const message = baseMessage({
      toolCalls: [
        {
          id: "tc-1",
          name: "read_file",
          args: { path: "/tmp/a.txt" },
          result: "hello world",
          status: "success",
        },
      ],
      sequence: [
        { type: "text", data: "Let me look." },
        {
          type: "tool",
          data: {
            toolCallId: "tc-1",
            name: "read_file",
            input: { path: "/tmp/a.txt" },
            output: "hello world",
            status: "success",
          },
        },
      ],
    });

    const restored = roundTrip(message);

    expect(restored.toolCalls).toEqual(message.toolCalls);
    expect(restored.sequence).toEqual(message.sequence);
  });

  it("stores the sequence payload once, as a pointer into tool_calls", () => {
    const output = "x".repeat(50_000);
    const { toolCallsJson, sequenceJson } = serializeMessagePayloads({
      dbDir,
      chatId: "chat-1",
      messageId: "msg-1",
      message: baseMessage({
        toolCalls: [
          { id: "tc-1", name: "bash", args: { command: "ls" }, result: output },
        ],
        sequence: [
          {
            type: "tool",
            data: {
              toolCallId: "tc-1",
              name: "bash",
              input: { command: "ls" },
              output,
            },
          },
        ],
      }),
    });

    // The payload lives in tool_calls only; sequence keeps ordering metadata.
    expect(toolCallsJson).toContain(output);
    expect(sequenceJson).not.toContain(output);
    expect(sequenceJson!.length).toBeLessThan(500);

    const sequence = JSON.parse(sequenceJson!);
    expect(sequence[0].data.outputRef).toBe("toolCall:string");
    expect(sequence[0].data.inputRef).toBe("toolCall");
    expect(sequence[0].data.output).toBeUndefined();
  });

  it("keeps a JSON output's shape through the pointer", () => {
    const output = { rows: [1, 2, 3], ok: true };
    const message = baseMessage({
      toolCalls: [
        {
          id: "tc-1",
          name: "query",
          args: {},
          result: JSON.stringify(output),
        },
      ],
      sequence: [
        { type: "tool", data: { toolCallId: "tc-1", name: "query", output } },
      ],
    });

    const restored = roundTrip(message);
    expect((restored.sequence![0] as any).data.output).toEqual(output);
  });

  it("keeps a null output inline, since tool_calls cannot round-trip it", () => {
    const message = baseMessage({
      toolCalls: [{ id: "tc-1", name: "noop", args: {}, result: undefined }],
      sequence: [
        { type: "tool", data: { toolCallId: "tc-1", name: "noop", output: null } },
      ],
    });

    const restored = roundTrip(message);
    expect((restored.sequence![0] as any).data.output).toBeNull();
  });

  it("leaves an orphan sequence item untouched when it is small", () => {
    const message = baseMessage({
      sequence: [
        {
          type: "tool",
          data: { toolCallId: "gone", name: "x", output: "small" },
        },
      ],
    });

    const restored = roundTrip(message);
    expect((restored.sequence![0] as any).data.output).toBe("small");
  });
});

describe("offloading oversized results", () => {
  it("moves a result past the threshold to a sidecar, losslessly", () => {
    const result = "y".repeat(OFFLOAD_THRESHOLD_CHARS + 1000);
    const message = baseMessage({
      toolCalls: [{ id: "tc-1", name: "scrape", args: {}, result }],
      sequence: [
        { type: "tool", data: { toolCallId: "tc-1", name: "scrape", output: result } },
      ],
    });

    const { toolCallsJson } = serializeMessagePayloads({
      dbDir,
      chatId: "chat-1",
      messageId: "msg-1",
      message,
    });

    const toolCalls = JSON.parse(toolCallsJson!);
    const stored = toolCalls[0];

    // Row shrank, but a preview and a pointer stayed behind.
    expect(stored.result.length).toBeLessThan(result.length);
    expect(stored.result.startsWith(result.slice(0, OFFLOAD_PREVIEW_CHARS))).toBe(true);
    expect(stored.result).toContain("get_full_tool_result");
    expect(stored.resultOffload.totalChars).toBe(result.length);

    // Nothing was lost — the sidecar holds the original.
    const restored = readOffloadedResult(dbDir, stored.resultOffload);
    expect(restored).toBe(result);

    const ref = findOffloadRef({ toolCalls } as StoredMessage, "tc-1");
    expect(ref?.file).toBe(stored.resultOffload.file);
  });

  it("spills the largest results until the row fits its budget", () => {
    // Ten results just under the per-result threshold still make a huge row.
    const chunk = "z".repeat(200 * 1024);
    const toolCalls = Array.from({ length: 10 }, (_, i) => ({
      id: `tc-${i}`,
      name: "bash",
      args: {},
      result: chunk,
    }));

    const { toolCallsJson } = serializeMessagePayloads({
      dbDir,
      chatId: "chat-1",
      messageId: "msg-1",
      message: baseMessage({ toolCalls }),
    });

    expect(toolCallsJson!.length).toBeLessThan(MAX_ROW_PAYLOAD_CHARS * 1.2);

    const stored = JSON.parse(toolCallsJson!);
    const offloaded = stored.filter((tc: any) => tc.resultOffload);
    expect(offloaded.length).toBeGreaterThan(0);

    // Every spilled result is still readable in full.
    for (const tc of offloaded) {
      expect(readOffloadedResult(dbDir, tc.resultOffload)).toBe(chunk);
    }
  });

  it("offloads an oversized sequence output that has no tool_calls twin", () => {
    const output = "q".repeat(OFFLOAD_THRESHOLD_CHARS + 1000);
    const { sequenceJson } = serializeMessagePayloads({
      dbDir,
      chatId: "chat-1",
      messageId: "msg-1",
      message: baseMessage({
        sequence: [
          { type: "tool", data: { toolCallId: "orphan", name: "x", output } },
        ],
      }),
    });

    const sequence = JSON.parse(sequenceJson!);
    expect(sequence[0].data.output.length).toBeLessThan(output.length);
    expect(readOffloadedResult(dbDir, sequence[0].data.outputOffload)).toBe(output);
  });

  it("refuses to read a ref pointing outside the sidecar tree", () => {
    expect(
      readOffloadedResult(dbDir, { file: "../../etc/passwd", totalChars: 1 }),
    ).toBeNull();
  });

  it("removes a chat's sidecars when the chat is deleted", () => {
    serializeMessagePayloads({
      dbDir,
      chatId: "chat-1",
      messageId: "msg-1",
      message: baseMessage({
        toolCalls: [
          {
            id: "tc-1",
            name: "scrape",
            args: {},
            result: "w".repeat(OFFLOAD_THRESHOLD_CHARS + 10),
          },
        ],
      }),
    });

    const chatDir = path.join(dbDir, SIDECAR_DIRNAME, "chat-1");
    expect(fs.existsSync(chatDir)).toBe(true);

    deleteChatSidecars(dbDir, "chat-1");
    expect(fs.existsSync(chatDir)).toBe(false);
  });

  it("does not mutate the message it was given", () => {
    const result = "m".repeat(OFFLOAD_THRESHOLD_CHARS + 10);
    const message = baseMessage({
      toolCalls: [{ id: "tc-1", name: "scrape", args: {}, result }],
      sequence: [
        { type: "tool", data: { toolCallId: "tc-1", name: "scrape", output: result } },
      ],
    });

    serializeMessagePayloads({
      dbDir,
      chatId: "chat-1",
      messageId: "msg-1",
      message,
    });

    // Callers still sync the full-fidelity object to Papr after saving.
    expect(message.toolCalls![0].result).toBe(result);
    expect((message.sequence![0] as any).data.output).toBe(result);
  });
});
