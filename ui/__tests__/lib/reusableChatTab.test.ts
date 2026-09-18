/**
 * Blank-chat reuse rules for "New Chat".
 *
 * Regression: clicking New Chat (sidebar / tab-bar + / Cmd+T) did nothing when
 * a blank chat tab was already open — reuse switched to a tab that was already
 * on screen, often one merged with an app in split view.
 */

import { describe, it, expect } from "vitest";
import {
  findReusableChatTab,
  isBlankChatTab,
  isMergedTab,
  type ChatStoreProbe,
} from "../../lib/reusableChatTab";
import type { Tab } from "../../types/tabs";

function tab(overrides: Partial<Tab> & { entityId: string }): Tab {
  return {
    id: `chat-${overrides.entityId}`,
    type: "chat",
    title: "New Chat",
    parentTabId: null,
    childTabIds: [],
    displayMode: "standalone",
    metadata: {},
    ...overrides,
  } as Tab;
}

/** Store stub: every listed chat is empty; drafts come from `drafts`. */
function store(drafts: Record<string, string> = {}): ChatStoreProbe {
  return {
    getChatState: () => ({ messages: [] as unknown[] }),
    getDraftMessage: (chatId: string) => drafts[chatId] ?? "",
  };
}

describe("findReusableChatTab", () => {
  it("reuses a blank standalone chat for background flows", () => {
    const blank = tab({ entityId: "temp-1" });
    expect(findReusableChatTab({ tabs: [blank], chatStore: store() })).toBe(blank);
  });

  it("never reuses when the user explicitly asked for a new chat", () => {
    const blank = tab({ entityId: "temp-1" });
    expect(
      findReusableChatTab({ tabs: [blank], chatStore: store(), forceNew: true }),
    ).toBeNull();
  });

  it("skips a blank chat merged with an app (split view)", () => {
    const merged = tab({ entityId: "temp-1", parentTabId: "app-1", displayMode: "child" });
    expect(findReusableChatTab({ tabs: [merged], chatStore: store() })).toBeNull();
  });

  it("skips a blank chat that is itself a parent of a merged pane", () => {
    const parent = tab({
      entityId: "temp-1",
      displayMode: "parent",
      childTabIds: ["app-1"],
    });
    expect(findReusableChatTab({ tabs: [parent], chatStore: store() })).toBeNull();
  });

  it("skips a chat holding an unsent draft", () => {
    const drafted = tab({ entityId: "temp-1" });
    expect(
      findReusableChatTab({ tabs: [drafted], chatStore: store({ "temp-1": "half typed" }) }),
    ).toBeNull();
  });

  it("treats whitespace-only drafts as empty", () => {
    const blank = tab({ entityId: "temp-1" });
    expect(
      findReusableChatTab({ tabs: [blank], chatStore: store({ "temp-1": "   \n" }) }),
    ).toBe(blank);
  });

  it("skips a streaming chat", () => {
    const streaming = tab({ entityId: "temp-1", isStreaming: true });
    expect(findReusableChatTab({ tabs: [streaming], chatStore: store() })).toBeNull();
  });

  it("skips persisted (non-temp) chats and non-chat tabs", () => {
    const persisted = tab({ entityId: "chat-42", id: "chat-chat-42" });
    const appTab = tab({ entityId: "temp-9", id: "app-9", type: "app" });
    expect(
      findReusableChatTab({ tabs: [persisted, appTab], chatStore: store() }),
    ).toBeNull();
  });

  it("returns the first reusable tab past unusable ones", () => {
    const merged = tab({ entityId: "temp-1", parentTabId: "app-1", displayMode: "child" });
    const blank = tab({ entityId: "temp-2" });
    expect(
      findReusableChatTab({ tabs: [merged, blank], chatStore: store() }),
    ).toBe(blank);
  });

  it("does not reuse when the chat store is unreadable", () => {
    const blank = tab({ entityId: "temp-1" });
    expect(findReusableChatTab({ tabs: [blank], chatStore: undefined })).toBeNull();
    expect(findReusableChatTab({ tabs: [blank], chatStore: {} })).toBeNull();
  });
});

describe("tab predicates", () => {
  it("flags every non-standalone shape as merged", () => {
    expect(isMergedTab(tab({ entityId: "temp-1" }))).toBe(false);
    expect(isMergedTab(tab({ entityId: "temp-1", parentTabId: "app-1" }))).toBe(true);
    expect(isMergedTab(tab({ entityId: "temp-1", childTabIds: ["app-1"] }))).toBe(true);
    expect(isMergedTab(tab({ entityId: "temp-1", displayMode: "child" }))).toBe(true);
  });

  it("requires an empty message list", () => {
    const withMessages: ChatStoreProbe = {
      getChatState: () => ({ messages: [{ id: "m1" }] }),
      getDraftMessage: () => "",
    };
    expect(isBlankChatTab(tab({ entityId: "temp-1" }), withMessages)).toBe(false);
  });
});
