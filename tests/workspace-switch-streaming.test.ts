import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  abortActiveAgentStreams,
  confirmAndAbortStreamsForWorkspaceSwitch,
  getActiveStreamChatIds,
  hasActiveAgentStreams,
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
    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(true);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("aborts streams when user confirms workspace switch", async () => {
    activeStreamRequests.set("chat-5", "req-5");
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.spyOn(gateway, "cancelRequest").mockImplementation(() => {});
    vi.spyOn(gateway, "send").mockResolvedValue({ success: true, data: undefined });

    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(true);
    expect(gateway.send).toHaveBeenCalledWith("agent:stop", { chatId: "chat-5" });
  });

  it("cancels workspace switch when user declines confirm", async () => {
    activeStreamRequests.set("chat-6", "req-6");
    vi.mocked(window.confirm).mockReturnValue(false);
    const sendSpy = vi.spyOn(gateway, "send");

    await expect(confirmAndAbortStreamsForWorkspaceSwitch()).resolves.toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
