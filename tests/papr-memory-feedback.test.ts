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
  paprUserScope: vi.fn(() => ({ external_user_id: "user-test-1" })),
}));

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

  it("search_agent_memory returns searchId and auto-submits empty-search feedback", async () => {
    mockSearch.mockResolvedValue({
      search_id: "search-empty",
      status: "success",
      data: { memories: [], nodes: [] },
    });

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
