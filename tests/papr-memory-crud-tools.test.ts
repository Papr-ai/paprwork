import { describe, it, expect, beforeEach, vi } from "vitest";
import Papr from "@papr/memory";
import {
  updateMemoryTool,
  addAgentMemoryBatchTool,
  getMemoryBatchStatusTool,
  submitMemoryFeedbackBatchTool,
  getMemoryFeedbackTool,
} from "../src/core/tools/paprMemory.js";
import { getPaprClient } from "../src/core/tools/paprClient.js";

vi.mock("../src/core/tools/paprClient.js", () => ({
  getPaprClient: vi.fn(),
  handlePaprToolError: (error: unknown): never => {
    throw error;
  },
  isPaprNotFoundError: (): boolean => false,
}));

vi.mock("../src/gateway/utils/paprUserId.js", () => ({
  paprUserScope: vi.fn(() => ({ external_user_id: "user-test-1" })),
  getPaprUserId: vi.fn(() => "user-test-1"),
  getPaprCallerIdentity: vi.fn(() => ({ userId: "user-test-1" })),
  invalidatePaprUserIdCache: vi.fn(),
}));

// WorkspaceContext resolution hits the schemas API; pin it so batch writes
// assert against a deterministic graph policy.
vi.mock("../src/gateway/utils/workspaceContextSchema.js", () => ({
  buildAgentMemoryAddPolicy: vi.fn(async () => ({
    graph: { mode: "auto", schema_id: "schema-workspace-context" },
  })),
}));

vi.mock("../src/gateway/utils/memoryScopeResolver.js", () => ({
  buildPaprMemoryWriteScope: vi.fn(async (input?: { addPolicy?: unknown }) => ({
    external_user_id: "user-test-1",
    namespace_id: "ns-test-1",
    policy: input?.addPolicy,
  })),
  resolveExplicitReadAclFromToolArgs: vi.fn(() => undefined),
}));

describe("papr memory CRUD + feedback tools", () => {
  const mockUpdate = vi.fn();
  const mockAddBatch = vi.fn();
  const mockBatchStatus = vi.fn();
  const mockFeedbackSubmitBatch = vi.fn();
  const mockFeedbackGetByID = vi.fn();
  const mockDeleteAll = vi.fn();

  beforeEach(() => {
    for (const m of [
      mockUpdate,
      mockAddBatch,
      mockBatchStatus,
      mockFeedbackSubmitBatch,
      mockFeedbackGetByID,
      mockDeleteAll,
    ]) {
      m.mockReset();
    }

    vi.mocked(getPaprClient).mockResolvedValue({
      memory: {
        update: mockUpdate,
        addBatch: mockAddBatch,
        retrieveBatchStatus: mockBatchStatus,
        deleteAll: mockDeleteAll,
      },
      feedback: {
        submitBatch: mockFeedbackSubmitBatch,
        getByID: mockFeedbackGetByID,
      },
    } as unknown as Papr);
  });

  describe("update_memory", () => {
    it("updates content in place without creating a duplicate", async () => {
      mockUpdate.mockResolvedValue({ status: "success", memory_id: "mem-1" });

      const result = await updateMemoryTool.execute({
        memoryId: "mem-1",
        content: "Raise reconciled: $1,005,000 committed as of 14 Aug 2026.",
      });

      expect(mockUpdate).toHaveBeenCalledWith("mem-1", {
        content: "Raise reconciled: $1,005,000 committed as of 14 Aug 2026.",
      });
      expect(result.success).toBe(true);
      expect(result.memoryId).toBe("mem-1");
      expect(result.message).toContain("no duplicate created");
    });

    it("sends only metadata when content is omitted", async () => {
      mockUpdate.mockResolvedValue({ status: "success" });

      await updateMemoryTool.execute({
        memoryId: "mem-2",
        metadata: { topics: ["fundraising"] },
      });

      expect(mockUpdate).toHaveBeenCalledWith("mem-2", {
        metadata: { topics: ["fundraising"] },
      });
    });

    it("rejects a no-op update instead of issuing an empty PUT", async () => {
      await expect(
        updateMemoryTool.execute({ memoryId: "mem-3" }),
      ).rejects.toThrow(/at least one of/i);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("add_agent_memory_batch", () => {
    it("writes all items in ONE request with the WorkspaceContext graph policy", async () => {
      mockAddBatch.mockResolvedValue({
        status: "success",
        batch_id: "batch-xyz",
        total_processed: 2,
      });

      const result = await addAgentMemoryBatchTool.execute({
        memories: [
          {
            content: "Megan Maloney is a solo GP at Dria Ventures.",
            category: "fact",
            role: "user",
            topics: ["fundraising"],
          },
          {
            content: "Dria Ventures is in active diligence, likely $250K check.",
            category: "fact",
            role: "user",
          },
        ],
      });

      expect(mockAddBatch).toHaveBeenCalledTimes(1);
      const payload = mockAddBatch.mock.calls[0]![0];
      expect(payload.memories).toHaveLength(2);
      expect(payload.memories[0].content).toContain("Megan Maloney");
      expect(payload.memories[0].metadata).toMatchObject({
        role: "user",
        category: "fact",
        topics: ["fundraising"],
      });
      // Batch must carry the same graph policy as single add, otherwise
      // batched entities land as flat text with no graph extraction.
      expect(payload.policy).toEqual({
        graph: { mode: "auto", schema_id: "schema-workspace-context" },
      });
      expect(payload.external_user_id).toBe("user-test-1");
      expect(payload.namespace_id).toBe("ns-test-1");

      expect(result.requested).toBe(2);
      expect(result.batchId).toBe("batch-xyz");
      expect(result._statusReminder).toContain("get_memory_batch_status");
    });

    it("forwards batching options only when provided", async () => {
      mockAddBatch.mockResolvedValue({ status: "success", batch_id: "b-1" });

      await addAgentMemoryBatchTool.execute({
        memories: [{ content: "one" }],
        skipBackgroundProcessing: true,
        batchSize: 10,
      });

      const payload = mockAddBatch.mock.calls[0]![0];
      expect(payload.skip_background_processing).toBe(true);
      expect(payload.batch_size).toBe(10);
    });

    it("omits optional flags when not set", async () => {
      mockAddBatch.mockResolvedValue({ status: "success", batch_id: "b-2" });

      await addAgentMemoryBatchTool.execute({
        memories: [{ content: "only content" }],
      });

      const payload = mockAddBatch.mock.calls[0]![0];
      expect(payload).not.toHaveProperty("skip_background_processing");
      expect(payload).not.toHaveProperty("batch_size");
    });

    it("returns null batchId rather than throwing when server omits it", async () => {
      mockAddBatch.mockResolvedValue({ status: "success" });

      const result = await addAgentMemoryBatchTool.execute({
        memories: [{ content: "no batch id returned" }],
      });

      expect(result.batchId).toBeNull();
      expect(result.success).toBe(true);
    });

    it("rejects batches over the 50-item cap at the schema layer", () => {
      const oversized = {
        memories: Array.from({ length: 51 }, (_, i) => ({ content: `m${i}` })),
      };
      expect(
        addAgentMemoryBatchTool.inputSchema.safeParse(oversized).success,
      ).toBe(false);
    });
  });

  describe("get_memory_batch_status", () => {
    it("polls batch status so slow writes are not mistaken for failures", async () => {
      mockBatchStatus.mockResolvedValue({
        status: "processing",
        total: 35,
        completed: 12,
      });

      const result = await getMemoryBatchStatusTool.execute({
        batchId: "batch-xyz",
      });

      expect(mockBatchStatus).toHaveBeenCalledWith("batch-xyz");
      expect(result.batchId).toBe("batch-xyz");
      expect(result.data).toMatchObject({ status: "processing" });
    });
  });

  describe("submit_memory_feedback_batch", () => {
    it("submits multiple feedback items in one request with user scope", async () => {
      mockFeedbackSubmitBatch.mockResolvedValue({
        status: "success",
        processed: 2,
      });

      const result = await submitMemoryFeedbackBatchTool.execute({
        items: [
          {
            searchId: "search-1",
            feedbackType: "thumbs_up",
            citedMemoryIds: ["mem-1"],
          },
          {
            searchId: "search-2",
            feedbackType: "memory_relevance",
            feedbackScore: 2,
            feedbackText: "Returned job logs, not priorities.",
          },
        ],
      });

      expect(mockFeedbackSubmitBatch).toHaveBeenCalledTimes(1);
      const payload = mockFeedbackSubmitBatch.mock.calls[0]![0];
      expect(payload.feedback_items).toHaveLength(2);
      expect(payload.feedback_items[0]).toMatchObject({
        search_id: "search-1",
        external_user_id: "user-test-1",
        feedbackData: {
          feedbackSource: "inline",
          feedbackType: "thumbs_up",
          citedMemoryIds: ["mem-1"],
        },
      });
      expect(payload.feedback_items[1].feedbackData).toMatchObject({
        feedbackType: "memory_relevance",
        feedbackScore: 2,
      });
      expect(result.submitted).toBe(2);
    });

    it("defaults feedbackSource to inline", async () => {
      mockFeedbackSubmitBatch.mockResolvedValue({ status: "success" });

      await submitMemoryFeedbackBatchTool.execute({
        items: [{ searchId: "search-3", feedbackType: "thumbs_down" }],
      });

      const payload = mockFeedbackSubmitBatch.mock.calls[0]![0];
      expect(payload.feedback_items[0].feedbackData.feedbackSource).toBe(
        "inline",
      );
    });
  });

  describe("get_memory_feedback", () => {
    it("fetches a feedback record by id", async () => {
      mockFeedbackGetByID.mockResolvedValue({
        status: "success",
        feedback_id: "fb-123",
        search_id: "search-1",
      });

      const result = await getMemoryFeedbackTool.execute({
        feedbackId: "fb-123",
      });

      expect(mockFeedbackGetByID).toHaveBeenCalledWith("fb-123");
      expect(result.feedbackId).toBe("fb-123");
    });
  });

  describe("safety", () => {
    it("does not expose DELETE /v1/memory/all to the agent", async () => {
      const { paprMemoryTools } = await import(
        "../src/core/tools/paprMemory.js"
      );
      const ids = paprMemoryTools.map((t) => t.id);

      expect(ids).toContain("update_memory");
      expect(ids).toContain("add_agent_memory_batch");
      expect(ids).toContain("get_memory_batch_status");
      expect(ids).toContain("submit_memory_feedback_batch");
      expect(ids).toContain("get_memory_feedback");

      // deleteAll is intentionally unwired — too destructive for agent use.
      expect(ids).not.toContain("delete_all_memories");
      expect(mockDeleteAll).not.toHaveBeenCalled();
    });
  });
});
