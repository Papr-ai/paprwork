/**
 * Chat dots come from the notices table: a chat.done FYI → green "done"; an open
 * Priority notice (job or Pen waiting on you) → blue "needs"; working wins over both.
 * Same answer on the tab bar, the Chats rail icon and every chat list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatStore } from "../stores/chatStore";
import { useNoticeStore } from "../stores/noticeStore";
import { useChatActivity, useChatsBadge } from "../components/Chat/chatActivity";
import type { Notice, NoticeMark } from "../../src/core/types/notices";

function notice(chatId: string, mark: NoticeMark, kind = mark === "green" ? "chat.done" : "key.request"): Notice {
  return {
    id: `${kind}-${chatId}`, key: `${kind}:${chatId}`, kind, type: mark === "green" ? "event" : "condition",
    level: mark === "green" ? "fyi" : "priority", mark, title: "t", count: 1,
    source: { type: "agent", id: "pen", name: "Pen" }, owner: { kind: "chat", id: chatId, name: chatId },
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  };
}

const set = (...n: Notice[]) => act(() => useNoticeStore.getState().setNotices(n));

describe("useChatActivity (notices)", () => {
  beforeEach(() => {
    useChatStore.setState({ chatStates: new Map(), streamingState: new Map() });
    useNoticeStore.setState({ notices: [] });
  });

  it("green when a reply finished, gone when the notice clears", () => {
    const { result } = renderHook(() => useChatActivity());
    expect(result.current("b")).toBeUndefined();
    set(notice("b", "green"));
    expect(result.current("b")).toBe("done");
    set();
    expect(result.current("b")).toBeUndefined();
  });

  it("blue beats green on the same chat", () => {
    const { result } = renderHook(() => useChatActivity());
    set(notice("b", "green"), notice("b", "blue"));
    expect(result.current("b")).toBe("needs");
  });

  it("works for chats with no open tab", () => {
    const { result } = renderHook(() => useChatActivity());
    set(notice("no-tab", "green"));
    expect(result.current("no-tab")).toBe("done");
  });

  it("shows working over needs while the agent is mid-turn", () => {
    const { result } = renderHook(() => useChatActivity());
    set(notice("b", "blue"));
    act(() => {
      const s = useChatStore.getState();
      const next = new Map(s.chatStates);
      next.set("b", { ...s.getChatState("b"), isStreaming: true });
      useChatStore.setState({ chatStates: next });
    });
    expect(result.current("b")).toBe("working");
  });

  it("Chats icon: blue if any chat needs you, else green", () => {
    const { result } = renderHook(() => useChatsBadge());
    expect(result.current).toBeUndefined();
    set(notice("a", "green"));
    expect(result.current).toBe("done");
    set(notice("a", "green"), notice("b", "blue"));
    expect(result.current).toBe("needs");
  });
});
