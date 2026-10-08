import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTabStore } from "../../stores/tabStore";
import { useChatStore } from "../../stores/chatStore";
import { openCloudInstalledAppWithChat } from "../../utils/openCloudInstalledAppWithChat";
import { isAppTabMergedWithChat } from "../../utils/appTabMerge";

function registerBlankChat(id: string) {
  const next = new Map(useChatStore.getState().chatStates);
  next.set(id, { messages: [], isLoading: false, isSending: false, isStreaming: false, hasUnread: false });
  useChatStore.setState({ chatStates: next });
}

describe("openCloudInstalledAppWithChat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTabStore.setState({ tabs: [], activeTabId: null, history: [], historyIndex: -1 });
    (window as unknown as { __chatStore__: unknown }).__chatStore__ = {
      getChatState: (id: string) => useChatStore.getState().chatStates.get(id),
      getDraftMessage: () => "",
    };
  });

  it("merges into a reused blank chat tab instead of leaving app in its own tab", async () => {
    registerBlankChat("temp-existing");
    useTabStore.getState().createTab("chat", "temp-existing", "New Chat");

    await openCloudInstalledAppWithChat(async () => {
      registerBlankChat("temp-new");
      return "temp-new";
    }, { appId: "a1", appTitle: "App", agentMessage: "hi" });
    vi.runAllTimers();

    const tabs = useTabStore.getState().tabs;
    const chatTabs = tabs.filter((t) => t.type === "chat");
    expect(chatTabs).toHaveLength(1);
    expect(isAppTabMergedWithChat(chatTabs[0].id, "app-a1")).toBe(true);
  });

  it("does not spawn a second chat when the temp id is swapped for a real one", async () => {
    await openCloudInstalledAppWithChat(async () => {
      registerBlankChat("temp-x");
      return "temp-x";
    }, { appId: "a2", appTitle: "App", agentMessage: "hi" });
    useTabStore.getState().updateTabId("chat-temp-x", "chat-real1");
    vi.runAllTimers();

    const chatTabs = useTabStore.getState().tabs.filter((t) => t.type === "chat");
    expect(chatTabs.map((t) => t.id)).toEqual(["chat-real1"]);
    expect(isAppTabMergedWithChat("chat-real1", "app-a2")).toBe(true);
  });
});
