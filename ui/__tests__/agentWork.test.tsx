/**
 * Replay: the rail agent retraces its mark while any user-facing chat is streaming,
 * seals once when the last one finishes, then rests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatStore } from "../stores/chatStore";
import { useAgentWork } from "../components/Agent/agentWork";

type ChatStates = ReturnType<typeof useChatStore.getState>["chatStates"];

function stream(ids: string[]) {
  act(() => {
    useChatStore.setState((s) => {
      const next: ChatStates = new Map();
      s.chatStates.forEach((v, k) => next.set(k, { ...v, isStreaming: false }));
      ids.forEach((id) => next.set(id, { ...(s.chatStates.get(id) ?? s.getChatState(id)), isStreaming: true }));
      return { chatStates: next };
    });
  });
}

describe("useAgentWork", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({ chatStates: new Map() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rests when nothing is streaming", () => {
    const { result } = renderHook(() => useAgentWork());
    expect(result.current).toEqual({ state: "idle", count: 0 });
  });

  it("works while chats stream and counts them", () => {
    const { result } = renderHook(() => useAgentWork());
    stream(["a", "b"]);
    expect(result.current).toEqual({ state: "working", count: 2 });
    stream(["a"]);
    expect(result.current).toEqual({ state: "working", count: 1 });
  });

  it("ignores background job and delegation sessions", () => {
    const { result } = renderHook(() => useAgentWork());
    stream(["job:x:run1", "delegation:d1"]);
    expect(result.current.state).toBe("idle");
  });

  it("seals once when the last chat finishes, then rests", () => {
    const { result } = renderHook(() => useAgentWork());
    stream(["a"]);
    stream([]);
    expect(result.current).toEqual({ state: "done", count: 0 });
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(result.current.state).toBe("idle");
  });

  it("goes straight back to working if new work starts mid-seal", () => {
    const { result } = renderHook(() => useAgentWork());
    stream(["a"]);
    stream([]);
    stream(["b"]);
    expect(result.current).toEqual({ state: "working", count: 1 });
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(result.current.state).toBe("working");
  });
});
