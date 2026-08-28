import { describe, expect, it, beforeEach } from "vitest";
import { useChatStore } from "../ui/stores/chatStore";
import { useTabStore } from "../ui/stores/tabStore";
import {
  chatEntityIdFromTabId,
  findPairedChatTabIdForAppTab,
  isAppTabMergedWithChat,
  isPairedChatActivelyStreaming,
} from "../ui/utils/appTabMerge";

describe("appTabMerge", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      activeLeftTab: null,
      activeRightTab: null,
      isSplitView: false,
    });
    useChatStore.setState({
      chatStates: new Map(),
    });
  });

  it("detects chat+app split merge", () => {
    useTabStore.setState({
      tabs: [
        {
          id: "chat-abc",
          type: "chat",
          entityId: "abc",
          title: "Chat",
          displayMode: "parent",
          childTabIds: ["app-app1"],
          parentTabId: null,
          position: "left",
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: "app-app1",
          type: "app",
          entityId: "app1",
          title: "Todos",
          displayMode: "child",
          childTabIds: [],
          parentTabId: "chat-abc",
          position: "right",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    expect(isAppTabMergedWithChat("chat-abc", "app-app1")).toBe(true);
    expect(findPairedChatTabIdForAppTab("app-app1")).toBe("chat-abc");
    expect(chatEntityIdFromTabId("chat-abc")).toBe("abc");
  });

  it("returns false when app tab is standalone", () => {
    useTabStore.setState({
      tabs: [
        {
          id: "app-app1",
          type: "app",
          entityId: "app1",
          title: "Todos",
          displayMode: "standalone",
          childTabIds: [],
          parentTabId: null,
          position: "left",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    expect(isAppTabMergedWithChat("chat-abc", "app-app1")).toBe(false);
    expect(findPairedChatTabIdForAppTab("app-app1")).toBeNull();
  });

  it("detects active streaming on paired chat", () => {
    useTabStore.setState({
      tabs: [
        {
          id: "chat-abc",
          type: "chat",
          entityId: "abc",
          title: "Chat",
          displayMode: "parent",
          childTabIds: ["app-app1"],
          parentTabId: null,
          position: "left",
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: "app-app1",
          type: "app",
          entityId: "app1",
          title: "Todos",
          displayMode: "child",
          childTabIds: [],
          parentTabId: "chat-abc",
          position: "right",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    useChatStore.setState({
      chatStates: new Map([
        [
          "abc",
          {
            chatId: "abc",
            messages: [],
            isSending: true,
            isStreaming: false,
          },
        ],
      ]),
    });

    expect(isPairedChatActivelyStreaming("app1")).toBe(true);
  });
});
