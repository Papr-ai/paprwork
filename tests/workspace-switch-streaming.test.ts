import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  abortActiveAgentStreams,
  confirmAndAbortStreamsForWorkspaceSwitch,
  fetchActiveJobsForWorkspaceSwitch,
  getActiveStreamChatIds,
  hasActiveAgentStreams,
  stopActiveJobsForWorkspaceSwitch,
} from "../ui/lib/workspaceSwitchStreaming";
import { useChatStore } from "../ui/stores/chatStore";
import { activeStreamRequests } from "../ui/lib/agentStreamRecovery";
import { gateway } from "../ui/src/lib/gateway";

describe("workspaceSwitchStreaming", () => {
  beforeEach(() => {
    activeStreamRequests.clear();
    useChatStore.getState().resetForWorkspaceSwitch();
    vi.restoreAllMocks();
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  });

  it("returns false when nothing is streaming", () => {
    expect(hasActiveAgentStreams()).toBe(false);
    expect(getActiveStreamChatIds()).toEqual([]);
  });

  it("detects active stream request ids", () => {
    activeStreamRequests.set("chat-1", "req-1");
    expect(getActiveStreamChatIds()).toEqual(["chat-1"]);
    expect(hasActiveAgentStreams()).toBe(true);
  });

  it("detects chat store streaming flags", () => {
    useChatStore.getState().setChats([
      {
        id: "chat-2",
        title: "Test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        isStreaming: true,
      },
    ]);
    expect(getActiveStreamChatIds()).toContain("chat-2");
  });

  it("detects isSending on chat state", () => {
    useChatStore.getState().setSending("chat-3", true);
    expect(getActiveStreamChatIds()).toContain("chat-3");
  });

  it("aborts active streams via gateway stop", async () => {
    activeStreamRequests.set("chat-4", "req-4");
    useChatStore.getState().setSending("chat-4", true);

    const cancelSpy = vi.spyOn(gateway, "cancelRequest").mockImplementation(() => {});
    const sendSpy = vi
      .spyOn(gateway, "send")
      .mockResolvedValue({ success: true, data: undefined });

    await abortActiveAgentStreams(["chat-4"]);

    expect(cancelSpy).toHaveBeenCalledWith("req-4");
    expect(sendSpy).toHaveBeenCalledWith("agent:stop", { chatId: "chat-4" });
    expect(activeStreamRequests.has("chat-4")).toBe(false);
    expect(useChatStore.getState().chatStates.get("chat-4")?.isSending).toBe(false);
  });

  it("proceeds immediately when no streams are active", async () => {
    vi.spyOn(gateway, "send").mockResolvedValue({
      success: true,
      data: { jobs: [] },
    });

    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(true);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("aborts streams when user confirms workspace switch", async () => {
    activeStreamRequests.set("chat-5", "req-5");
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.spyOn(gateway, "cancelRequest").mockImplementation(() => {});
    vi.spyOn(gateway, "send").mockImplementation(async (type) => {
      if (type === "jobs:active-list") {
        return { success: true, data: { jobs: [] } };
      }
      return { success: true, data: undefined };
    });

    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(true);
    expect(gateway.send).toHaveBeenCalledWith("agent:stop", { chatId: "chat-5" });
  });

  it("cancels workspace switch when user declines confirm", async () => {
    activeStreamRequests.set("chat-6", "req-6");
    vi.mocked(window.confirm).mockReturnValue(false);
    const sendSpy = vi.spyOn(gateway, "send").mockResolvedValue({
      success: true,
      data: { jobs: [] },
    });

    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(false);
    expect(sendSpy).not.toHaveBeenCalledWith("agent:stop", { chatId: "chat-6" });
    expect(sendSpy).not.toHaveBeenCalledWith("jobs:stop-all", expect.anything());
  });

  it("fetches active jobs from gateway for workspace switch preflight", async () => {
    vi.spyOn(gateway, "send").mockResolvedValue({
      success: true,
      data: {
        jobs: [{ id: "job-1", name: "Weekly Brief", type: "agent", status: "running" }],
      },
    });

    await expect(fetchActiveJobsForWorkspaceSwitch()).resolves.toEqual([
      { id: "job-1", name: "Weekly Brief", type: "agent", status: "running" },
    ]);
  });

  it("stops active jobs when user confirms workspace switch", async () => {
    vi.spyOn(gateway, "send").mockImplementation(async (type) => {
      if (type === "jobs:active-list") {
        return {
          success: true,
          data: {
            jobs: [{ id: "job-2", name: "Scraper", type: "python", status: "running" }],
          },
        };
      }
      if (type === "jobs:stop-all") {
        return { success: true, data: { stoppedCount: 1 } };
      }
      return { success: true, data: undefined };
    });
    vi.mocked(window.confirm).mockReturnValue(true);

    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(true);
    expect(gateway.send).toHaveBeenCalledWith("jobs:stop-all", {
      reason: "Job stopped — workspace switch",
    });
  });

  it("cancels workspace switch when user declines with active jobs", async () => {
    vi.spyOn(gateway, "send").mockResolvedValue({
      success: true,
      data: {
        jobs: [{ id: "job-3", name: "ETL", type: "python", status: "running" }],
      },
    });
    vi.mocked(window.confirm).mockReturnValue(false);
    const stopAllSpy = vi.spyOn(gateway, "send");

    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(false);
    expect(stopAllSpy).not.toHaveBeenCalledWith("jobs:stop-all", expect.anything());
  });

  it("stopActiveJobsForWorkspaceSwitch calls jobs:stop-all", async () => {
    const sendSpy = vi
      .spyOn(gateway, "send")
      .mockResolvedValue({ success: true, data: { stoppedCount: 0 } });

    await stopActiveJobsForWorkspaceSwitch();

    expect(sendSpy).toHaveBeenCalledWith("jobs:stop-all", {
      reason: "Job stopped — workspace switch",
    });
  });
});
