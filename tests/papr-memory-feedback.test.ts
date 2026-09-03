import { describe, it, expect, beforeEach, vi } from "vitest";
import Papr from "@papr/memory";
import {
  formatSearchMemoryResponse,
  searchAgentMemoryTool,
  submitEmptySearchFeedback,
  submitMemoryFeedbackTool,
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
  paprUserScope: vi.fn(() => ({
    user_id: "user-test-1",
    external_user_id: "user-test-1",
  })),
  getPaprUserId: vi.fn(() => "user-test-1"),
  getPaprCallerIdentity: vi.fn(() => ({ userId: "user-test-1" })),
  invalidatePaprUserIdCache: vi.fn(),
}));

vi.mock("../src/gateway/utils/memoryScopeResolver.js", () => ({
  paprMemorySearchScopeSpread: vi.fn(async () => ({
    user_id: "user-test-1",
    external_user_id: "user-test-1",
  })),
}));

/**
 * The SDK returns an APIPromise: awaitable AND carrying withResponse(), which
 * resolves to { data, response }. search_agent_memory calls withResponse() to
 * read the X-Search-Id / X-Memory-Count / X-Node-Count headers, so the mock has
 * to model both shapes — a plain resolved value would not catch a regression.
 */
function mockApiPromise(data: unknown, headers: Record<string, string> = {}) {
  const promise = Promise.resolve(data) as Promise<unknown> & {
    withResponse: () => Promise<{ data: unknown; response: { headers: Headers } }>;
  };
  promise.withResponse = async () => ({
    data,
    response: { headers: new Headers(headers) },
  });
  return promise;
}

describe("papr memory feedback", () => {
  const mockSearch = vi.fn();
  const mockFeedbackSubmit = vi.fn();

  beforeEach(() => {
    mockSearch.mockReset();
    mockFeedbackSubmit.mockReset();
    vi.mocked(getPaprClient).mockResolvedValue({
      memory: { search: mockSearch },
      feedback: { submit: mockFeedbackSubmit },
    } as unknown as Papr);
    mockFeedbackSubmit.mockResolvedValue({
      status: "success",
      feedback_id: "fb-123",
      message: "Feedback recorded",
    });
  });

  it("formatSearchMemoryResponse surfaces searchId and counts", () => {
    const formatted = formatSearchMemoryResponse({
      search_id: "search-abc",
      status: "success",
      data: {
        memories: [{ id: "m1", content: "hello" }],
        nodes: [{ label: "Person", properties: {} }],
      },
    });

    expect(formatted.searchId).toBe("search-abc");
    expect(formatted.memoryCount).toBe(1);
    expect(formatted.nodeCount).toBe(1);
    expect(formatted._memoryFeedbackReminder).toContain('searchId: "search-abc"');
    expect(formatted._memoryFeedbackReminder).toContain("submit_memory_feedback");
  });

  it("search_agent_memory reads searchId and counts from response headers", async () => {
    // TOON body: data is a plain string, so counters must come from headers.
    mockSearch.mockReturnValue(
      mockApiPromise(
        "code: 200\nstatus: success\ndata:\n  memories[#10]:\nsearch_id: header-search-1",
        {
          "X-Content-Format": "toon",
          "X-Search-Id": "header-search-1",
          "X-Memory-Count": "10",
          "X-Node-Count": "3",
        },
      ),
    );

    const result = await searchAgentMemoryTool.execute({
      query: "Find fundraising commitments and investor diligence status this month.",
    });

    expect(result.searchId).toBe("header-search-1");
    expect(result.memoryCount).toBe(10);
    expect(result.nodeCount).toBe(3);
    // Results were returned, so no low-relevance feedback should be auto-submitted.
    expect(mockFeedbackSubmit).not.toHaveBeenCalled();
  });

  it("search_agent_memory falls back to TOON body when headers are absent", async () => {
    // Older server without X-Search-Id headers — parser must still recover both.
    mockSearch.mockReturnValue(
      mockApiPromise(
        "code: 200\nstatus: success\ndata:\n  memories[#7]:\n  nodes[#2]:\nsearch_id: 1aaafbd9-ec56-4345-8be2-9d603542e802",
      ),
    );

    const result = await searchAgentMemoryTool.execute({
      query: "Find architecture notes about graph embeddings and routing tiers.",
    });

    expect(result.searchId).toBe("1aaafbd9-ec56-4345-8be2-9d603542e802");
    expect(result.memoryCount).toBe(7);
    expect(result.nodeCount).toBe(2);
    expect(mockFeedbackSubmit).not.toHaveBeenCalled();
  });

  it("search_agent_memory returns searchId and auto-submits empty-search feedback", async () => {
    mockSearch.mockReturnValue(
      mockApiPromise({
        search_id: "search-empty",
        status: "success",
        data: { memories: [], nodes: [] },
      }),
    );

    const result = await searchAgentMemoryTool.execute({
      query: "Find architecture notes about graph embeddings and routing tiers.",
    });

    expect(result.searchId).toBe("search-empty");
    expect(result.memoryCount).toBe(0);
    expect(result._memoryFeedbackReminder).toContain('searchId="search-empty"');
    expect(result._memoryFeedbackReminder).toContain("auto-submitted");

    await vi.waitFor(() => {
      expect(mockFeedbackSubmit).toHaveBeenCalledWith({
        search_id: "search-empty",
        user_id: "user-test-1",
        external_user_id: "user-test-1",
        feedbackData: {
          feedbackSource: "inline",
          feedbackType: "memory_relevance",
          feedbackText: "Search returned zero memories for the query.",
          feedbackScore: 1,
        },
      });
    });
  });

  it("submit_memory_feedback forwards searchId and cited memories", async () => {
    const result = await submitMemoryFeedbackTool.execute({
      searchId: "search-good",
      feedbackType: "thumbs_up",
      citedMemoryIds: ["mem-1", "mem-2"],
      feedbackText: "Both memories were directly relevant.",
    });

    expect(mockFeedbackSubmit).toHaveBeenCalledWith({
      search_id: "search-good",
      user_id: "user-test-1",
      external_user_id: "user-test-1",
      feedbackData: {
        feedbackSource: "inline",
        feedbackType: "thumbs_up",
        citedMemoryIds: ["mem-1", "mem-2"],
        feedbackText: "Both memories were directly relevant.",
      },
    });
    expect(result.feedbackId).toBe("fb-123");
  });

  it("submitEmptySearchFeedback swallows API errors", async () => {
    mockFeedbackSubmit.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      submitEmptySearchFeedback(
        { feedback: { submit: mockFeedbackSubmit } } as unknown as Papr,
        "search-fail",
      ),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
