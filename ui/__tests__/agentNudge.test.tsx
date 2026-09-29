/**
 * The Lean — infinity eyes, and a nudge that only asks at breakpoints and parks itself when ignored.
 * Frequency caps live in the gateway (nudgePolicy.test.ts); this covers the renderer's timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { AgentGlyph } from "../components/Agent/AgentGlyph";
import { AgentNudge } from "../components/Agent/AgentNudge";
import { NUDGE_TIMING, useAgentNudge, type AgentNudgeData } from "../components/Agent/useAgentNudge";

const NUDGE: AgentNudgeData = {
  key: "due:G1:2026-09-30",
  kind: "due",
  line: "Tranche 2 is due tomorrow.",
  sub: "No time on it this week",
  go: "Open it",
  later: "Later",
  action: { type: "focus", goalId: "G1" },
};

const calls = (fetchMock: ReturnType<typeof vi.fn>, path: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(path));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AgentGlyph eyes", () => {
  it("draws one infinity loop (the Memory mark) instead of two pills", () => {
    const { container } = render(<AgentGlyph size={36} look="orb" color="blue" />);
    const lids = container.querySelector(".agent-glyph__lids");
    expect(lids?.querySelectorAll("rect")).toHaveLength(0);
    expect(lids?.querySelector("path")?.getAttribute("d")).toMatch(/^M12 12c-1\.9-2\.6/);
    expect(lids?.getAttribute("stroke")).toMatch(/^url\(#agent-grad-/);
  });
});

describe("useAgentNudge — breakpoints only", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).endsWith("/next") ? { nudge: NUDGE, reason: "ok" } : { ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks once you have settled in, then plays in → open and records the show", async () => {
    const { result } = renderHook(() => useAgentNudge("idle", vi.fn()));
    expect(calls(fetchMock, "/next")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.settleMs));
    await flush();
    expect(result.current.phase).toBe("in");
    expect(JSON.parse(calls(fetchMock, "/event")[0][1].body)).toMatchObject({ key: NUDGE.key, event: "shown" });
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.arriveMs));
    expect(result.current.phase).toBe("open");
  });

  it("does not interrupt while you are typing", async () => {
    renderHook(() => useAgentNudge("idle", vi.fn()));
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.settleMs - 1_000));
    fireEvent.keyDown(window, { key: "a" });
    await act(async () => vi.advanceTimersByTime(1_000));
    await flush();
    expect(calls(fetchMock, "/next")).toHaveLength(0);
  });

  it("does not interrupt while your agent is working, and asks after the work lands", async () => {
    const { rerender } = renderHook(({ s }) => useAgentNudge(s, vi.fn()), {
      initialProps: { s: "working" as "working" | "idle" | "done" },
    });
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.settleMs));
    await flush();
    expect(calls(fetchMock, "/next")).toHaveLength(0);
    rerender({ s: "done" });
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.afterWorkMs));
    await flush();
    expect(calls(fetchMock, "/next")).toHaveLength(1);
  });

  it("parks an untouched nudge as a still dot after 45s, without counting it as an answer", async () => {
    const { result } = renderHook(() => useAgentNudge("idle", vi.fn()));
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.settleMs));
    await flush();
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.arriveMs + NUDGE_TIMING.autoParkMs + NUDGE_TIMING.leaveMs));
    expect(result.current.phase).toBe("rest");
    expect(calls(fetchMock, "/event").map(([, init]) => JSON.parse(init.body).event)).toEqual(["shown"]);
  });

  it("Later parks it; Go hands the action to the rail and records it", async () => {
    const onGo = vi.fn();
    const { result } = renderHook(() => useAgentNudge("idle", onGo));
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.settleMs + NUDGE_TIMING.arriveMs));
    await flush();
    act(() => result.current.later());
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.leaveMs));
    expect(result.current.phase).toBe("rest");
    act(() => {
      result.current.reopen();
    });
    await act(async () => vi.advanceTimersByTime(NUDGE_TIMING.arriveMs));
    act(() => result.current.go());
    expect(onGo).toHaveBeenCalledWith({ type: "focus", goalId: "G1" });
    expect(result.current.phase).toBe("off");
    expect(calls(fetchMock, "/event").map(([, init]) => JSON.parse(init.body).event)).toEqual(["shown", "later", "go"]);
  });
});

describe("AgentNudge", () => {
  it("offers one move and one way out", () => {
    const noop = vi.fn();
    render(
      <AgentNudge nudge={NUDGE} phase="open" onGo={noop} onLater={noop} onDismiss={noop} onReopen={noop} onHold={noop} />,
    );
    expect(screen.getByRole("status").textContent).toContain("Tranche 2 is due tomorrow.");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Open it", "Later"]);
  });

  it("uses the dismiss wording instead of Later when the nudge offers one", () => {
    const onDismiss = vi.fn();
    const noop = vi.fn();
    render(
      <AgentNudge
        nudge={{ ...NUDGE, dismiss: "It's intentional" }}
        phase="open"
        onGo={noop}
        onLater={noop}
        onDismiss={onDismiss}
        onReopen={noop}
        onHold={noop}
      />,
    );
    fireEvent.click(screen.getByText("It's intentional"));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("rests as one dot you can tap", () => {
    const onReopen = vi.fn();
    const noop = vi.fn();
    render(<AgentNudge nudge={NUDGE} phase="rest" onGo={noop} onLater={noop} onDismiss={noop} onReopen={onReopen} onHold={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /has a nudge/ }));
    expect(onReopen).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
