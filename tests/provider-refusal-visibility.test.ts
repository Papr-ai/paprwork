import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { recoveryBannerSurvivesStreamEnd } from "../ui/lib/streamRecoveryPersistence";
import {
  costBasisIsCharged,
  costBasisRunningNote,
  costBasisStatLabel,
  formatChatTotalsLine,
  formatCostAmount,
  resolveCostBasis,
  type PlanUsageSummary,
} from "../ui/utils/subscriptionPlanUsage";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Strip comments so a static assertion cannot be satisfied by prose. */
function stripComments(source: string): string {
  return source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function plan(over: Partial<PlanUsageSummary> = {}): PlanUsageSummary {
  return {
    provider: "anthropic",
    sessionPercent: 10,
    weeklyPercent: 10,
    sessionIsActive: true,
    weeklyIsActive: false,
    scopedWeekly: [],
    activePercent: 10,
    activeLabel: "Current session",
    subscriptionType: "max",
    extraUsageEnabled: null,
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

describe("recovery banner survives the stream's terminal chunk", () => {
  /**
   * The reported failure: a 429 raised the banner and the `done` chunk that
   * always follows (Issue 49) cleared it milliseconds later, so the user saw
   * no reply and no explanation.
   */
  it("keeps a rate-limit banner when done arrives", () => {
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: true,
        reason: "rateLimit",
      }),
    ).toBe(true);
  });

  it("clears a connection banner when done arrives", () => {
    // A connection banner is raised while output is still expected, so a
    // `done` that does arrive is evidence the stream finished.
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: true,
        reason: "connectionLost",
      }),
    ).toBe(false);
  });

  it("does nothing when no banner is up", () => {
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: false,
        reason: "rateLimit",
      }),
    ).toBe(false);
  });

  it("clears when the reason was never recorded", () => {
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: true,
        reason: undefined,
      }),
    ).toBe(false);
  });

  it("useAgent guards the done-path clear rather than clearing unconditionally", () => {
    const source = stripComments(read("ui/hooks/useAgent.ts"));
    expect(source).toContain("recoveryBannerSurvivesStreamEnd");
    // The bare unconditional clear on the done path is what erased the error.
    const guarded = source.indexOf("recoveryBannerSurvivesStreamEnd({");
    expect(guarded).toBeGreaterThan(-1);
  });
});

describe("cost basis is decided by plan utilization, not by credential", () => {
  /**
   * The reported complaint: an OAuth login past its $200 allowance is spending
   * real money per turn, and the UI called it "included usage". Which
   * credential authenticated says nothing about whether the plan is spent.
   */
  it("treats an exhausted subscription as overage", () => {
    expect(
      resolveCostBasis("subscription", plan({ sessionPercent: 100 })),
    ).toBe("plan_overage");
  });

  it("treats a subscription inside its allowance as included", () => {
    expect(
      resolveCostBasis("subscription", plan({ sessionPercent: 42 })),
    ).toBe("plan_included");
  });

  it("does not claim overage when the provider refuses extra usage", () => {
    // extraUsageEnabled === false means the request is rejected rather than
    // billed, so nothing is being spent.
    expect(
      resolveCostBasis(
        "subscription",
        plan({ sessionPercent: 100, extraUsageEnabled: false }),
      ),
    ).toBe("plan_included");
  });

  it("reports unknown rather than guessing when plan usage is unreadable", () => {
    expect(resolveCostBasis("subscription", null)).toBe("plan_unknown");
  });

  it("leaves metered billing alone", () => {
    expect(resolveCostBasis("metered", null)).toBe("metered");
    expect(resolveCostBasis("metered", plan({ sessionPercent: 100 }))).toBe(
      "metered",
    );
  });

  it("separates a charge from a list-price estimate", () => {
    expect(costBasisIsCharged("metered")).toBe(true);
    expect(costBasisIsCharged("plan_overage")).toBe(true);
    expect(costBasisIsCharged("plan_included")).toBe(false);
    expect(costBasisIsCharged("plan_unknown")).toBe(false);
  });

  it("labels the stat so the figure cannot be misread", () => {
    expect(costBasisStatLabel("plan_overage")).toBe("cost");
    expect(costBasisStatLabel("plan_included")).toBe("list");
  });

  it("never tells an over-limit user the turn is free", () => {
    expect(costBasisRunningNote("plan_overage")).toContain("on top of your plan");
    expect(costBasisRunningNote("plan_overage")).not.toContain("Counts toward");
  });
});

describe("the dollar figure is always shown", () => {
  it("shows spend on a subscription chat", () => {
    const line = formatChatTotalsLine(
      "subscription",
      12,
      8.43,
      plan({ sessionPercent: 100 }),
    );
    expect(line).toContain("$8.43");
    expect(line).toContain("on top of your plan");
  });

  it("marks an in-plan figure as list price", () => {
    const line = formatChatTotalsLine(
      "subscription",
      3,
      1.5,
      plan({ sessionPercent: 10 }),
    );
    expect(line).toContain("$1.50");
    expect(line).toContain("at list");
  });

  it("no longer suppresses the amount as 'included usage'", () => {
    // The old line for every subscription chat, regardless of spend.
    expect(formatChatTotalsLine("subscription", 3, 1.5, null)).not.toBe(
      "3 turns · included usage",
    );
  });

  it("keeps metered wording unchanged", () => {
    expect(formatChatTotalsLine("metered", 1, 2.5)).toBe("1 turn · $2.50 this chat");
  });

  it("keeps cheap turns from rounding to zero", () => {
    // A 4-decimal floor: $0.0012 shown as $0.00 reads as free.
    expect(formatCostAmount(0.0012)).toBe("$0.0012");
    expect(formatCostAmount(0.25)).toBe("$0.250");
    expect(formatCostAmount(12.5)).toBe("$12.50");
    expect(formatCostAmount(0)).toBe("$0");
  });

  it("TurnCostStrip no longer gates the stat on billing mode", () => {
    const source = stripComments(read("ui/components/Chat/TurnCostStrip.tsx"));
    expect(source).not.toContain('billingMode === "metered" ? (');
    expect(source).toContain("costBasisStatLabel(basis)");
  });

  it("the plan hero leads with money once the allowance is spent", () => {
    const source = stripComments(
      read("ui/components/Chat/ContextPlanUsageHero.tsx"),
    );
    expect(source).toContain('=== "plan_overage"');
    expect(source).toContain("formatCostAmount(lastTurnCost)");
  });
});

/**
 * The body of one hook-scoped declaration, up to the next sibling.
 *
 * Ends at the next `\n  const ` — two spaces exactly, which is the indent of a
 * declaration in the hook body and not of anything nested inside one. A brace
 * scan would be defeated by the braces in the object literals within.
 */
function sliceFunction(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  expect(start, anchor).toBeGreaterThan(-1);
  const next = source.indexOf("\n  const ", start + anchor.length);
  return source.slice(start, next > -1 ? next : source.length);
}

describe("the banner is read before the calls that clear it", () => {
  /**
   * Why the guard above was dead code. `setConnectionPaused(false)` drops
   * `needsStreamRecovery` as a side effect, and the done handler ran it one
   * line before reading the banner — so the survival check saw `false` no
   * matter what the provider had said, and cleared the banner anyway.
   */
  it("setConnectionPaused(false) clears needsStreamRecovery", async () => {
    const { useChatStore, defaultChatState } = await import(
      "../ui/stores/chatStore"
    );
    const id = "chat-unpause-clears-banner";
    useChatStore.setState((s) => ({
      chatStates: new Map(s.chatStates).set(id, { ...defaultChatState }),
    }));

    const store = () => useChatStore.getState();
    store().setNeedsStreamRecovery(id, true, "rateLimit", "429 from Anthropic");
    expect(store().chatStates.get(id)?.needsStreamRecovery).toBe(true);

    store().setConnectionPaused(id, false);
    expect(store().chatStates.get(id)?.needsStreamRecovery).toBe(false);
  });

  /**
   * Re-scoped from the `done` arm to `settleChatAfterStreamEnd`.
   *
   * These two originally sliced the `case "done":` arm, because that is where
   * the read-then-clear sequence lived. It has since moved into one helper
   * shared by all four `done` exits and by the reconnect cleanup — three of
   * which previously cleared the banner unconditionally, so scoping the
   * assertion to the arm left those exits unguarded. The requirement is
   * unchanged: read the banner before the calls that clear it, and put it
   * back. Only the place that requirement is met has moved.
   */
  it("the settle helper reads the banner before it unpauses", () => {
    const settle = sliceFunction(
      stripComments(read("ui/hooks/useAgent.ts")),
      "const settleChatAfterStreamEnd",
    );
    const readAt = settle.indexOf("recoveryBannerSurvivesStreamEnd({");
    const clearAt = settle.indexOf("setConnectionPaused(chatId, false)");
    expect(readAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(clearAt);
  });

  it("the settle helper puts the reason and the provider's sentence back", () => {
    // Unpausing already dropped the flag, so a surviving banner has to be
    // re-asserted with its reason and detail or it renders as nothing.
    const settle = sliceFunction(
      stripComments(read("ui/hooks/useAgent.ts")),
      "const settleChatAfterStreamEnd",
    );
    expect(settle).toContain("streamRecoveryDetail");
  });

  it("every done exit and the reconnect cleanup go through the helper", () => {
    // The count is the point: four `done` exits plus cleanupStreamState. A new
    // exit that settles state by hand is the defect this issue was, so it must
    // not be able to pass by leaving the helper in place beside it.
    const source = stripComments(read("ui/hooks/useAgent.ts"));
    const calls = source.match(/settleChatAfterStreamEnd\(chatId\)/g) ?? [];
    expect(calls.length).toBe(5);
  });
});

describe("a refusal is recorded somewhere a per-chat write cannot drop it", () => {
  /**
   * The reported failure, and the asymmetry behind it. Both branches handle a
   * provider refusing the turn outright, and they chose different surfaces:
   *
   *   quota exhausted  -> setError(rawError)   -> global, survived, was seen
   *   rate limited     -> setError(null)       -> per-chat only, was not
   *
   * The per-chat banner is cleared as a side effect by several callers, so the
   * rate-limit branch had thrown away its only surviving copy of the message.
   * That is why the message appeared on an API key (org spend cap -> quota) and
   * not on a subscription login (per-minute ceiling -> rate limit).
   */
  it("the rate-limit branch no longer discards the provider's sentence", () => {
    const source = stripComments(read("ui/hooks/useAgent.ts"));
    const arm = source.slice(source.indexOf("RATE_LIMIT_EXHAUSTED_ERROR_CODE)"));
    const body = arm.slice(0, arm.indexOf("untrackActiveStream"));
    expect(body).toContain("setError(rawError)");
    expect(body).not.toContain("setError(null)");
  });

  it("both refusal branches record the sentence on the same surface", () => {
    const source = stripComments(read("ui/hooks/useAgent.ts"));
    for (const code of [
      "PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE)",
      "RATE_LIMIT_EXHAUSTED_ERROR_CODE)",
    ]) {
      const arm = source.slice(source.indexOf(code));
      const body = arm.slice(0, arm.indexOf("untrackActiveStream"));
      expect(body, code).toContain("setError(rawError)");
      expect(body, code).toContain('setLastTurnOutcome(chatId, "providerRefused")');
    }
  });

  it("the two banners never render together", () => {
    // Both surfaces now hold the same sentence, so without this the refusal
    // would be reported twice, one above the other.
    const source = stripComments(read("ui/components/Chat/ChatContainer.tsx"));
    expect(source).toContain("{error && !needsStreamRecovery && (");
  });

  it("Resume clears the error as well as the banner", () => {
    // Resume dismisses the banner. Leaving `error` set would reveal the copy
    // underneath and report the refusal again on the turn retrying it.
    const retry = sliceFunction(
      stripComments(read("ui/hooks/useAgent.ts")),
      "const retryStreamRecovery",
    );
    const clearBanner = retry.indexOf("setNeedsStreamRecovery(chatId, false)");
    const clearError = retry.indexOf("setError(null)");
    expect(clearBanner).toBeGreaterThan(-1);
    expect(clearError).toBeGreaterThan(-1);
    // Must be unconditional, i.e. before the `if (requestId)` branch that used
    // to be the only place it happened.
    expect(clearError).toBeLessThan(retry.indexOf("if (requestId)"));
  });

  it("a real user message retires the banner but a hidden continue does not", () => {
    // A refusal banner now outlives its stream, so a new message has to retire
    // it or Resume offers to retry a turn the user already replaced. Gated on
    // the hidden-continue check so auto-continue cannot clear the very banner
    // that is meant to be blocking it (Issue 109).
    const source = stripComments(read("ui/hooks/useAgent.ts"));
    const gate = source.indexOf("if (!isHiddenContinueUserMessage(message)) {");
    expect(gate).toBeGreaterThan(-1);
    const block = source.slice(gate, source.indexOf("}", gate));
    expect(block).toContain("setLastTurnOutcome(chatId, undefined)");
    expect(block).toContain("setNeedsStreamRecovery(chatId, false)");
  });

  it("names the call site when a refusal banner is cleared", async () => {
    // The flag is cleared as a side effect by actions whose stated purpose is
    // something else, so when it vanished nothing in the log said which one
    // did it and the culprit had to be guessed at from chunk order.
    const { useChatStore, defaultChatState } = await import(
      "../ui/stores/chatStore"
    );
    const id = "chat-refusal-clear-is-logged";
    useChatStore.setState((s) => ({
      chatStates: new Map(s.chatStates).set(id, { ...defaultChatState }),
    }));

    const store = () => useChatStore.getState();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      store().setNeedsStreamRecovery(id, true, "rateLimit", "429 from Anthropic");
      store().setConnectionPaused(id, false);
    } finally {
      console.warn = original;
    }

    expect(warnings.some((w) => w.includes("setConnectionPaused"))).toBe(true);
    expect(warnings.some((w) => w.includes(id))).toBe(true);
  });

  it("stays quiet for an ordinary connection banner", () => {
    // Bounded noise: a refusal happens at most once a turn, a reconnect does
    // not, so only the refusal is worth a stack trace.
    const source = stripComments(read("ui/stores/chatStore.ts"));
    expect(source).toContain('streamRecoveryReason !== "rateLimit"');
  });
});
