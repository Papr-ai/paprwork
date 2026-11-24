import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../ui/src/lib/gateway", () => ({
  gateway: {
    send: vi.fn(),
  },
}));

import { gateway } from "../../ui/src/lib/gateway";
import { useChatStore } from "../../ui/stores/chatStore";
import { useTabStore } from "../../ui/stores/tabStore";
import { presetChatTitle, scheduleChatTitleGeneration } from "../../ui/lib/scheduleChatTitle";

describe("scheduleChatTitleGeneration", () => {
  beforeEach(() => {
    vi.mocked(gateway.send).mockReset();
    useChatStore.setState({ chats: [] });
    useTabStore.setState({ tabs: [], activeTabId: null });
  });

  it("skips hidden auto-continue messages", () => {
    scheduleChatTitleGeneration("chat-1", "[__papr_continue__]");
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("updates tab and chat list when title returns", async () => {
    useTabStore.getState().createTab("chat", "chat-1", "New Chat");
    vi.mocked(gateway.send).mockResolvedValue({
      success: true,
      data: { title: "Weekly planning" },
    });

    scheduleChatTitleGeneration("chat-1", "Help me plan my week");
    await vi.waitFor(() => {
      expect(useTabStore.getState().tabs[0]?.title).toBe("Weekly planning");
    });
    expect(useChatStore.getState().chats[0]?.title).toBe("Weekly planning");
  });

  it("keeps a title the chat was opened with, ignores the default", () => {
    expect(presetChatTitle("Review shared data")).toBe("Review shared data");
    expect(presetChatTitle("  Set up HubSpot ")).toBe("Set up HubSpot");
    expect(presetChatTitle("New Chat")).toBeUndefined();
    expect(presetChatTitle("")).toBeUndefined();
    expect(presetChatTitle(undefined)).toBeUndefined();
  });
});
