import { describe, expect, it } from "vitest";
import {
  buildPlanContinuationNudge,
  decideTurnEnd,
  MAX_PLAN_CONTINUATIONS_PER_TURN,
  trailingTextAfterLastTool,
  trailingTextAwaitsUser,
  type TurnEndInput,
} from "../src/gateway/services/agent/turnContinuation.js";

/** A turn that ran tools and then stopped with a mid-work preamble. */
function preambleStop(overrides: Partial<TurnEndInput> = {}): TurnEndInput {
  return {
    pendingPlanSteps: 2,
    trailingText: "Now let me check the launcher config:",
    endsOnToolWithoutText: false,
    toolCallCount: 12,
    aborted: false,
    hasInterruptedTools: false,
    continuationsUsed: 0,
    ...overrides,
  };
}

describe("decideTurnEnd", () => {
  it("resumes a turn that stopped mid-plan after a preamble", () => {
    // The regression: trailing text used to skip every intervention, so the
    // turn ended and the UI reported "Finished Working" over pending steps.
    expect(decideTurnEnd(preambleStop())).toEqual({
      action: "continue",
      reason: "plan_steps_pending",
    });
  });

  it("resumes when the model went silent mid-plan", () => {
    const decision = decideTurnEnd(
      preambleStop({ trailingText: "", endsOnToolWithoutText: true }),
    );
    expect(decision.action).toBe("continue");
  });

  it("never sends the terminal wrap-up while steps are pending", () => {
    // Previously this returned a wrap-up whose prompt asserts "This turn is
    // complete", manufacturing a completion over unfinished work.
    const decision = decideTurnEnd(
      preambleStop({
        trailingText: "",
        endsOnToolWithoutText: true,
        continuationsUsed: MAX_PLAN_CONTINUATIONS_PER_TURN,
      }),
    );
    expect(decision.action).toBe("wrap_up");
    expect(decision.wrapUpKind).toBe("plan_incomplete");
  });

  it("keeps the terminal wrap-up when no plan work remains", () => {
    const decision = decideTurnEnd(
      preambleStop({
        pendingPlanSteps: 0,
        trailingText: "",
        endsOnToolWithoutText: true,
      }),
    );
    expect(decision).toEqual({
      action: "wrap_up",
      reason: "tools_without_reply",
      wrapUpKind: "complete",
    });
  });

  it("leaves plan-free turns with trailing text untouched", () => {
    expect(decideTurnEnd(preambleStop({ pendingPlanSteps: 0 }))).toEqual({
      action: "none",
      reason: "trailing_text_after_tools",
    });
  });

  it("does not interrupt a model that is waiting on the user", () => {
    const decision = decideTurnEnd(
      preambleStop({
        trailingText:
          "I'll do the one approved action, then lay out the full data-program plan for your approval.",
      }),
    );
    expect(decision).toEqual({ action: "none", reason: "awaiting_user_input" });
  });

  it("stops pushing once the continuation budget is spent", () => {
    const spent = decideTurnEnd(
      preambleStop({ continuationsUsed: MAX_PLAN_CONTINUATIONS_PER_TURN }),
    );
    expect(spent).toEqual({
      action: "none",
      reason: "continuation_budget_exhausted",
    });
  });

  it("respects abort over everything else", () => {
    expect(decideTurnEnd(preambleStop({ aborted: true })).action).toBe("none");
  });

  it("does not push a text-only reply that called no tools", () => {
    const decision = decideTurnEnd(preambleStop({ toolCallCount: 0 }));
    expect(decision).toEqual({ action: "none", reason: "no_tool_calls" });
  });

  it("defers to the interrupted-tool path", () => {
    const decision = decideTurnEnd(preambleStop({ hasInterruptedTools: true }));
    expect(decision).toEqual({ action: "none", reason: "interrupted_tools" });
  });
});

describe("trailingTextAwaitsUser", () => {
  // Verbatim tails from turns that stopped mid-work in production logs.
  const midWork = [
    "Now let me see how the v56a launcher invokes `autonomous_loop` (the middle section), so gate 4 can mirror it exactly:",
    "Let me pull the actual μ numbers for the coding tasks from the canvases so the document cites measured values.",
    "I'll start by reading the current patent document and surveying the training materials.",
    "Confirmed — granting Amir access to all three namespaces. Running the apply now. I'll stage it: **nodes first** (fast).",
    "Decisive test — comparing v56a step500 vs MHAR step500 across all shared datasets:",
  ];

  it.each(midWork)("treats mid-work narration as resumable: %s", (text) => {
    expect(trailingTextAwaitsUser(text)).toBe(false);
  });

  const handoffs = [
    "Tell me which, and whether you want the gate-3 mixer swapped in.",
    "Say the word and I'll run the smoke.",
    "Which would you prefer?",
    "Let me know how you want to proceed.",
    "That's a real weakening of purity, and it's your call, not mine.",
    "Do you want me to relaunch the campaign now?",
    "I need your decision on the mixer before launching.",
  ];

  it.each(handoffs)("treats a handoff as a legitimate stop: %s", (text) => {
    expect(trailingTextAwaitsUser(text)).toBe(true);
  });

  it("ignores a question buried early in a long report", () => {
    const report = `Why did the router freeze? ${"Detail sentence. ".repeat(60)}Proceeding with the uniform-init fix now.`;
    expect(trailingTextAwaitsUser(report)).toBe(false);
  });

  it("still detects a question ending in markdown emphasis", () => {
    expect(trailingTextAwaitsUser("Which mixer should I use?**")).toBe(true);
  });

  it("treats empty text as mid-work, not a handoff", () => {
    expect(trailingTextAwaitsUser("   ")).toBe(false);
  });
});

describe("trailingTextAfterLastTool", () => {
  it("returns only text emitted after the final tool call", () => {
    const sequence = [
      { type: "text", data: "Let me look." },
      { type: "tool", data: { name: "bash" } },
      { type: "text", data: "Found it. " },
      { type: "text", data: "Now patching:" },
    ];
    expect(trailingTextAfterLastTool(sequence)).toBe("Found it. Now patching:");
  });

  it("is empty when the turn ends on a tool call", () => {
    const sequence = [
      { type: "text", data: "Checking." },
      { type: "tool", data: { name: "bash" } },
    ];
    expect(trailingTextAfterLastTool(sequence)).toBe("");
  });

  it("returns all text when no tool ran", () => {
    expect(
      trailingTextAfterLastTool([{ type: "text", data: "Just an answer." }]),
    ).toBe("Just an answer.");
  });
});

describe("buildPlanContinuationNudge", () => {
  it("names the next step and forbids re-summarizing", () => {
    const nudge = buildPlanContinuationNudge({
      pendingSteps: 3,
      nextStepDescription: "Drain Parse grants to 0 pending",
    });
    expect(nudge).toContain("3 unfinished steps");
    expect(nudge).toContain("Drain Parse grants to 0 pending");
    expect(nudge).toContain("update_plan");
    expect(nudge).toContain("do not create a new plan");
    // Must leave an escape hatch, or it would loop against a real blocker.
    expect(nudge).toContain("ask one direct question and stop");
  });

  it("keeps the sentence readable for a single step", () => {
    const nudge = buildPlanContinuationNudge({ pendingSteps: 1 });
    expect(nudge).toContain("1 unfinished step,");
  });
});
