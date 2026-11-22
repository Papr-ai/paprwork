import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StoredMessage } from "../../../src/gateway/services/storage/IStorageProvider.js";
import {
  buildPaprSyncStoreBody,
  measurePaprStoreBodyBytes,
  PAPR_SYNC_MAX_BYTES,
} from "../../../src/gateway/services/storage/paprSyncPayload.js";
import {
  applySearchTags,
  attachTrainingPayload,
  isTrainingAvailable,
  isTrainingOptedIn,
  recordSearchOnToolCall,
  resetSearchTagsForTests,
  setTrainingConsentFetcherForTests,
  setTrainingUploaderForTests,
  TRAINING_INLINE_RESULT_BYTES,
  type TrainingToolBlock,
} from "../../../src/gateway/services/storage/trainingSync.js";

const uploads: Array<{ sha256: string; bytes: number }> = [];

function msg(toolCalls: StoredMessage["toolCalls"]): StoredMessage {
  return {
    id: "msg-1",
    chat_id: "chat-1",
    role: "assistant",
    content: "Found it in paprSyncPayload.ts and fixed the budget.",
    timestamp: "2026-11-20T20:00:00.000Z",
    sync_status: "sync_pending",
    toolCalls,
  };
}

function body(m: StoredMessage) {
  return buildPaprSyncStoreBody({ chatId: m.chat_id, message: m, userId: "u1", processMessages: false });
}

function trainingBlock(b: ReturnType<typeof body>): TrainingToolBlock[] | undefined {
  if (!Array.isArray(b.content)) return undefined;
  const t = b.content.find((c) => (c as { type: string }).type === "training_tool_calls") as
    | { calls: TrainingToolBlock[] }
    | undefined;
  return t?.calls;
}

const prevProfile = process.env.PAPR_PROFILE;

beforeEach(() => {
  // Training sync is development-only; most tests run as the dev profile.
  process.env.PAPR_PROFILE = "dev";
  uploads.length = 0;
  resetSearchTagsForTests();
  setTrainingUploaderForTests(async (_text, sha256, bytes) => {
    uploads.push({ sha256, bytes });
    return `chat-tool-results/ns/u1/${sha256.slice(0, 2)}/${sha256}`;
  });
});

afterEach(() => {
  if (prevProfile === undefined) delete process.env.PAPR_PROFILE;
  else process.env.PAPR_PROFILE = prevProfile;
  delete process.env.PAPR_TRAINING_SYNC;
  setTrainingConsentFetcherForTests(null);
  setTrainingUploaderForTests(null);
});

describe("development only", () => {
  test("production profile never opts in, even when the account says yes", async () => {
    delete process.env.PAPR_PROFILE;
    setTrainingConsentFetcherForTests(async () => true);
    expect(isTrainingAvailable()).toBe(false);
    expect(await isTrainingOptedIn()).toBe(false);
  });

  test("production profile adds no training payload", async () => {
    delete process.env.PAPR_PROFILE;
    setTrainingConsentFetcherForTests(async () => true);
    const m = msg([{ id: "t1", name: "bash", args: { command: "ls" }, result: "a.ts" } as never]);
    const b = body(m);
    expect(await attachTrainingPayload(b, m, async () => undefined)).toBe(false);
    expect(trainingBlock(b)).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  test("dev profile is available; PAPR_TRAINING_SYNC=0 turns it off", () => {
    expect(isTrainingAvailable()).toBe(true);
    process.env.PAPR_TRAINING_SYNC = "0";
    expect(isTrainingAvailable()).toBe(false);
  });
});

describe("consent", () => {
  test("fails closed on error", async () => {
    setTrainingConsentFetcherForTests(async () => {
      throw new Error("offline");
    });
    expect(await isTrainingOptedIn()).toBe(false);
  });
});

describe("opted out", () => {
  test("payload is today's payload plus only the client id", async () => {
    setTrainingConsentFetcherForTests(async () => false);
    const m = msg([{ id: "t1", name: "bash", args: { command: "grep -rn foo src" }, result: "x".repeat(5_000) }]);
    const before = body(m);
    const after = body(m);
    const changed = await attachTrainingPayload(after, m, async () => undefined);
    expect(changed).toBe(false);
    expect(trainingBlock(after)).toBeUndefined();
    expect(after.metadata.customMetadata.trainingEligible).toBeUndefined();
    expect(after.metadata.customMetadata.clientMessageId).toBe("msg-1");
    expect(after.content).toEqual(before.content);
    expect(uploads).toHaveLength(0);
  });
});

describe("opted in", () => {
  beforeEach(() => setTrainingConsentFetcherForTests(async () => true));

  test("full args and small results inline; nothing truncated", async () => {
    const longCmd = "rg -n 'buildPaprSyncStoreBody' " + "src/".repeat(300);
    const m = msg([{ id: "t1", name: "bash", args: { command: longCmd }, result: "a.ts:1: hit\n".repeat(200), status: "success" }]);
    const b = body(m);
    expect(await attachTrainingPayload(b, m, async () => undefined)).toBe(true);
    const calls = trainingBlock(b)!;
    expect(calls[0].args).toEqual({ command: longCmd });
    expect(calls[0].result).toBe("a.ts:1: hit\n".repeat(200));
    expect(b.metadata.customMetadata.trainingEligible).toBe(true);
    expect(uploads).toHaveLength(0);
  });

  test("large results become bucket pointers", async () => {
    const big = "line\n".repeat(TRAINING_INLINE_RESULT_BYTES);
    const m = msg([{ id: "t1", name: "read_file", args: { path: "/x" }, result: big }]);
    const b = body(m);
    await attachTrainingPayload(b, m, async () => undefined);
    const call = trainingBlock(b)![0];
    expect(call.result).toBeUndefined();
    expect(call.resultRef?.bytes).toBe(Buffer.byteLength(big));
    expect(call.resultRef?.key).toMatch(/^chat-tool-results\//);
    expect(uploads).toHaveLength(1);
  });

  test("offloaded (sidecar) results upload the full text, not the preview", async () => {
    const full = "FULL ".repeat(70_000);
    const m = msg([
      {
        id: "t1",
        name: "bash",
        args: { command: "cat big.log" },
        result: "[preview only]",
        resultOffload: { file: "tool-results/chat-1/msg-1/t1.txt", totalChars: full.length },
      },
    ]);
    const b = body(m);
    await attachTrainingPayload(b, m, async () => full);
    expect(trainingBlock(b)![0].resultRef?.bytes).toBe(Buffer.byteLength(full));
  });

  test("a 60-call turn stays under the row cap by moving the largest fields out", async () => {
    const calls = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      name: "bash",
      args: { command: `grep -rn pattern${i} src` },
      result: "r".repeat(9_000),
    }));
    const m = msg(calls);
    const b = body(m);
    expect(await attachTrainingPayload(b, m, async () => undefined)).toBe(true);
    expect(measurePaprStoreBodyBytes(b)).toBeLessThanOrEqual(PAPR_SYNC_MAX_BYTES);
    const out = trainingBlock(b)!;
    expect(out).toHaveLength(60);
    // every call keeps its full args, and every result is inline or a pointer
    for (const c of out) {
      expect(c.args?.command).toMatch(/^grep -rn pattern\d+ src$/);
      expect(Boolean(c.result) !== Boolean(c.resultRef)).toBe(true);
    }
  });

  test("searchId and useCase ride on the tool call", async () => {
    recordSearchOnToolCall("t1", "11111111-2222-3333-4444-555555555555", "memory");
    const m = msg([{ id: "t1", name: "search_agent_memory", args: { query: "Samir status" }, result: "{}" }]);
    expect(applySearchTags(m.toolCalls)).toBe(1);
    const b = body(m);
    await attachTrainingPayload(b, m, async () => undefined);
    const c = trainingBlock(b)![0];
    expect(c.searchId).toBe("11111111-2222-3333-4444-555555555555");
    expect(c.useCase).toBe("memory");
  });

  test("user messages are marked eligible but carry no training block", async () => {
    const m: StoredMessage = { ...msg(undefined), role: "user", content: "find the sync budget" };
    const b = body(m);
    await attachTrainingPayload(b, m, async () => undefined);
    expect(b.metadata.customMetadata.trainingEligible).toBe(true);
    expect(trainingBlock(b)).toBeUndefined();
  });
});
