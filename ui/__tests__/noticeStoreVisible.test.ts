/** What counts as "on screen" for notices: the active tab, and in a split both halves. */
import { beforeEach, describe, expect, it } from "vitest";
import { useTabStore } from "../stores/tabStore";
import { visibleChatIds } from "../stores/noticeStore";
import type { Tab } from "../types/tabs";

const chat = (id: string, extra: Partial<Tab> = {}) =>
  ({ id: `chat-${id}`, type: "chat", entityId: id, title: id, childTabIds: [], displayMode: "standalone", ...extra }) as Tab;

describe("visibleChatIds", () => {
  beforeEach(() => useTabStore.setState({ tabs: [], activeTabId: null }));

  it("is just the active chat", () => {
    useTabStore.setState({ tabs: [chat("a"), chat("b")], activeTabId: "chat-a" });
    expect(visibleChatIds()).toEqual(["a"]);
  });

  it("counts the parent and the child in a split", () => {
    useTabStore.setState({
      tabs: [chat("a", { displayMode: "parent", childTabIds: ["chat-b"] }), chat("b", { displayMode: "child" }), chat("c")],
      activeTabId: "chat-a",
    });
    expect(visibleChatIds()).toEqual(["a", "b"]);
  });

  it("skips non-chat halves", () => {
    useTabStore.setState({
      tabs: [{ ...chat("x"), id: "app-x", type: "app", childTabIds: ["chat-b"], displayMode: "parent" } as Tab, chat("b", { displayMode: "child" })],
      activeTabId: "app-x",
    });
    expect(visibleChatIds()).toEqual(["b"]);
  });
});
