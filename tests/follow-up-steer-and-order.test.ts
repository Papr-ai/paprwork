import { describe, expect, it } from "vitest";
import {
  consumeTurnStart,
  isYieldRequested,
  requestYieldAtBoundary,
  shouldStopForYield,
  STEER_FOLLOW_UP_NOTE,
  withSteerNote,
} from "../src/gateway/services/agent/steerYield.js";
import { decideTurnEnd } from "../src/gateway/services/agent/turnContinuation.js";
import { explainPostStreamWrapUp } from "../src/gateway/services/agent/turnEndDiagnostics.js";
import { widenForHiddenRows } from "../ui/hooks/useChat.js";

describe("steer: pause at next tool boundary", () => {
  it("stops only after a completed step once a yield is requested", () => {
    const id = "c1";
    expect(shouldStopForYield(id, 3)).toBe(false);
    requestYieldAtBoundary(id);
    expect(shouldStopForYield(id, 0)).toBe(false);
    expect(shouldStopForYield(id, 1)).toBe(true);
  });

  it("next real turn clears the yield and is tagged as a steered follow-up", () => {
    const id = "c2";
    requestYieldAtBoundary(id, 1000);
    expect(consumeTurnStart(id, { now: 2000 })).toEqual({ steerFollowUp: true });
    expect(isYieldRequested(id)).toBe(false);
    expect(consumeTurnStart(id, { now: 3000 })).toEqual({ steerFollowUp: false });
  });

  it("an auto-continue does not consume the user's follow-up tag", () => {
    const id = "c3";
    requestYieldAtBoundary(id, 0);
    expect(consumeTurnStart(id, { hiddenContinue: true, now: 1 }).steerFollowUp).toBe(false);
    expect(consumeTurnStart(id, { now: 2 }).steerFollowUp).toBe(true);
  });

  it("expires a stale follow-up tag", () => {
    requestYieldAtBoundary("c4", 0);
    expect(consumeTurnStart("c4", { now: 11 * 60_000 }).steerFollowUp).toBe(false);
  });

  it("inserts the note right after the last user message, once", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "tool call" },
      { role: "tool", content: "result" },
    ];
    const out = withSteerNote(msgs);
    expect(out[3]).toEqual({ role: "user", content: STEER_FOLLOW_UP_NOTE });
    expect(withSteerNote(out)).toHaveLength(out.length);
  });

  it("never plan-continues or wraps up on top of a yielded turn", () => {
    const base = {
      pendingPlanSteps: 2, trailingText: "", endsOnToolWithoutText: true,
      toolCallCount: 3, aborted: false, hasInterruptedTools: false, continuationsUsed: 0,
    };
    expect(decideTurnEnd({ ...base, yieldedToUser: true }).reason).toBe("yielded_to_user");
    expect(
      explainPostStreamWrapUp({
        sequence: [{ type: "tool", data: {} }], toolCallCount: 3,
        aborted: false, isWrapUpContinuation: false, yieldedToUser: true,
      } as never).skipReason,
    ).toBe("yielded_to_user");
  });
});

describe("history first page vs hidden auto-continue rows", () => {
  const hidden = { role: "user", content: "[__papr_continue__] Continue" };
  it("widens a page made of hidden rows so 'Earlier' is not shown for a short chat", async () => {
    const all = [{ role: "user", content: "hi" }, ...Array(63).fill(hidden), { role: "assistant", content: "x" }];
    const fetchPage = async (_: string, o: { limit?: number }) => all.slice(-(o.limit ?? 30));
    const page = await widenForHiddenRows("c", all.slice(-30), 30, fetchPage as never);
    expect(page.length).toBe(65); // whole chat loaded → hasMore false
  });
  it("leaves a normal page alone", async () => {
    const page = Array(30).fill({ role: "user", content: "x" });
    expect(await widenForHiddenRows("c", page, 30, (async () => { throw new Error("no"); }) as never)).toBe(page);
  });
});
