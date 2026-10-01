/**
 * Chat lists (rail peek, tab-bar history) show the same "done" green dot as the tab bar:
 * a background chat tab with hasUnread → activity "done"; working wins; reading clears it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTabStore } from "../stores/tabStore";
import { useChatStore } from "../stores/chatStore";
import { useChatActivity } from "../components/Chat/chatActivity";
import type { Tab } from "../types/tabs";

function chatTab(id: string, extra: Partial<Tab> = {}): Tab {
  return { id: `chat-${id}`, type: "chat", entityId: id, title: id, ...extra } as Tab;
}

describe("useChatActivity", () => {
  beforeEach(() => {
    useChatStore.setState({ chatStates: new Map(), streamingState: new Map() });
    useTabStore.setState({ tabs: [chatTab("a"), chatTab("b")], activeTabId: "chat-a" });
  });

  it("marks a background chat done when its tab gets the green dot", () => {
    const { result } = renderHook(() => useChatActivity());
    expect(result.current("b")).toBeUndefined();
    act(() => useTabStore.getState().setTabUnread("chat-b", true));
    expect(result.current("b")).toBe("done");
    act(() => useTabStore.getState().markTabAsRead("chat-b"));
    expect(result.current("b")).toBeUndefined();
  });

  it("never marks the active tab done (same rule as the tab bar)", () => {
    const { result } = renderHook(() => useChatActivity());
    act(() => useTabStore.getState().setTabUnread("chat-a", true));
    expect(result.current("a")).toBeUndefined();
  });

  it("shows working over done while the agent is mid-turn", () => {
    const { result } = renderHook(() => useChatActivity());
    act(() => useTabStore.getState().setTabUnread("chat-b", true));
    act(() => {
      const s = useChatStore.getState();
      const next = new Map(s.chatStates);
      next.set("b", { ...s.getChatState("b"), isStreaming: true });
      useChatStore.setState({ chatStates: next });
    });
    expect(result.current("b")).toBe("working");
  });
});
