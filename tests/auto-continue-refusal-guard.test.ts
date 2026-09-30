/**
 * Auto-continue must respect a provider refusal and an explicit Stop.
 *
 * Reproduced from a real session: Anthropic returned 429 five times in ~2
 * minutes, and between each refusal the renderer logged "Auto-continuing
 * interrupted turn … (attempt N/3)" and sent another `[__papr_continue__]`.
 * Pressing Stop did not help — it cleared the recovery banner, which was the
 * only record that the provider had refused, so the next tick retried again.
 *
 * The shape that defeated the old guard: a 429 fails before the first chunk,
 * so the turn has NO assistant message. `assistantMessageWasStopped` has
 * nothing to inspect and `lastUserTurnNeedsContinue` reads the turn as merely
 * unanswered — indistinguishable from a dropped connection, which is exactly
 * the case auto-continue exists for.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAutoContinueBlockReason,
  recordAutoContinueAttempt,
  resetAutoContinueAttempts,
  shouldAutoContinueInterruptedTurn,
} from "../ui/lib/agentStreamRecovery";
import type { ChatMessage } from "../ui/types/chat";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Strip comments before searching source, or a static assertion can be
 * satisfied by the rationale that explains the code rather than the code.
 * Line comments first: a `//` mentioning `/*` would otherwise open a block
 * the stripper then runs to the next `*\/`, deleting real code (Issue 98).
 */
function stripComments(source: string): string {
  return source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const CHAT = "chat-refused";

/** The reported case: user asked, provider refused before any output. */
const noAssistantYet: ChatMessage[] = [
  { id: "u1", role: "user", content: "what's left on this feature" },
];

/** A turn auto-continue is genuinely for: assistant started, then dropped. */
const interruptedTurn: ChatMessage[] = [
  { id: "u1", role: "user", content: "Build it" },
  {
    id: "a1",
    role: "assistant",
    content: "Partial",
    interrupted: true,
    sequence: [{ type: "tool", data: { toolName: "bash", status: "success" } }],
  },
];

function args(over: Record<string, unknown> = {}) {
  return {
    chatId: CHAT,
    messages: noAssistantYet,
    isSending: false,
    connectionPaused: false,
    needsStreamRecovery: false,
    gatewayReady: true,
    ...over,
  } as Parameters<typeof getAutoContinueBlockReason>[0];
}

beforeEach(() => {
  resetAutoContinueAttempts(CHAT);
});

describe("a provider refusal blocks auto-continue", () => {
  it("blocks when the refusal left no assistant message to inspect", () => {
    // Without the fix this returns null — the retry loop in the report.
    expect(
      getAutoContinueBlockReason(
        args({ lastTurnOutcome: "providerRefused" }),
      ),
    ).toBe("providerRefused");
  });

  it("blocks on a live rate-limit banner even with no recorded outcome", () => {
    // Belt and braces: `shouldAutoRetryStreamRecoveryAfterReconnect` has always
    // applied this rule, so a banner alone is sufficient evidence.
    expect(
      getAutoContinueBlockReason(
        args({ needsStreamRecovery: true, streamRecoveryReason: "rateLimit" }),
      ),
    ).toBe("providerRefused");
  });

  it("still auto-continues a connection drop — the case it exists for", () => {
    expect(
      getAutoContinueBlockReason(
        args({
          needsStreamRecovery: true,
          streamRecoveryReason: "connection",
        }),
      ),
    ).toBeNull();
    expect(
      shouldAutoContinueInterruptedTurn(
        args({
          needsStreamRecovery: true,
          streamRecoveryReason: "connection",
        }),
      ),
    ).toBe(true);
  });

  it("blocks a refused turn that also has an interrupted assistant message", () => {
    expect(
      getAutoContinueBlockReason(
        args({
          messages: interruptedTurn,
          lastTurnOutcome: "providerRefused",
        }),
      ),
    ).toBe("providerRefused");
  });

  it("leaves the unblocked interrupted turn unblocked", () => {
    expect(
      getAutoContinueBlockReason(args({ messages: interruptedTurn })),
    ).toBeNull();
  });
});

describe("an explicit Stop blocks auto-continue", () => {
  it("blocks when the turn produced nothing for the old check to read", () => {
    expect(
      getAutoContinueBlockReason(args({ lastTurnOutcome: "userStopped" })),
    ).toBe("userStopped");
  });

  it("blocks a Stop even after the banner was cleared by the teardown", () => {
    // `interruptActiveStream` sets needsStreamRecovery false. If Stop were read
    // off the banner, stopping a refused turn would erase the refusal.
    expect(
      getAutoContinueBlockReason(
        args({
          needsStreamRecovery: false,
          streamRecoveryReason: undefined,
          lastTurnOutcome: "userStopped",
        }),
      ),
    ).toBe("userStopped");
  });

  it("keeps blocking the pre-existing sequence-based stop signal", () => {
    // The old path still works where an assistant message does exist.
    const stopped: ChatMessage[] = [
      { id: "u1", role: "user", content: "Build it" },
      {
        id: "a1",
        role: "assistant",
        content: "Partial",
        interrupted: true,
        sequence: [
          {
            type: "tool",
            data: {
              toolName: "bash",
              status: "stopped",
              error: "Stopped by user",
            },
          },
        ],
      },
    ];
    expect(getAutoContinueBlockReason(args({ messages: stopped }))).toBe(
      "userStopped",
    );
  });
});

describe("the refusal check runs before the reasons it would otherwise hide", () => {
  it("reports the refusal, not maxAttempts, once attempts are spent", () => {
    recordAutoContinueAttempt(CHAT, noAssistantYet);
    recordAutoContinueAttempt(CHAT, noAssistantYet);
    recordAutoContinueAttempt(CHAT, noAssistantYet);
    // Both block, but the refusal is the actionable one to log and support.
    expect(
      getAutoContinueBlockReason(args({ lastTurnOutcome: "providerRefused" })),
    ).toBe("providerRefused");
  });

  it("reports the refusal, not gatewayNotReady", () => {
    expect(
      getAutoContinueBlockReason(
        args({ gatewayReady: false, lastTurnOutcome: "providerRefused" }),
      ),
    ).toBe("providerRefused");
  });

  it("still reports isSending first — a turn in flight is not a refusal", () => {
    expect(
      getAutoContinueBlockReason(
        args({ isSending: true, lastTurnOutcome: "providerRefused" }),
      ),
    ).toBe("isSending");
  });
});

describe("the store actually records the outcome", () => {
  it("writes the outcome, and clears it when set to undefined", async () => {
    const { useChatStore, defaultChatState } = await import(
      "../ui/stores/chatStore"
    );
    const id = "chat-store-outcome";
    useChatStore.setState((s) => ({
      chatStates: new Map(s.chatStates).set(id, { ...defaultChatState }),
    }));

    useChatStore.getState().setLastTurnOutcome(id, "providerRefused");
    expect(useChatStore.getState().chatStates.get(id)?.lastTurnOutcome).toBe(
      "providerRefused",
    );

    useChatStore.getState().setLastTurnOutcome(id, undefined);
    expect(
      useChatStore.getState().chatStates.get(id)?.lastTurnOutcome,
    ).toBeUndefined();
  });
});

describe("the outcome is cleared only by a deliberate new attempt", () => {
  const store = read("ui/stores/chatStore.ts");
  const agent = stripComments(read("ui/hooks/useAgent.ts"));
  const container = stripComments(read("ui/components/Chat/ChatContainer.tsx"));

  it("exposes setLastTurnOutcome from the store", () => {
    expect(store).toContain("setLastTurnOutcome:");
  });

  it("records providerRefused at both raise sites", () => {
    // Quota-exhausted offers no Resume, so the banner never carries it;
    // rate-limit does, but the banner is cleared by Stop. Both need the record.
    const raises = agent.match(
      /setLastTurnOutcome\([^)]*"providerRefused"\)/g,
    );
    expect(raises?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("records userStopped when the user presses Stop", () => {
    expect(container).toContain('setLastTurnOutcome(chatId, "userStopped")');
  });

  it("marks the Stop before awaiting the teardown", () => {
    // `interruptActiveStream` awaits the gateway, and the auto-continue effect
    // can run during that wait. Marking after the await leaves a window open.
    const body = container.slice(
      container.indexOf("const stopAgentAndClearQueue"),
    );
    const mark = body.indexOf('setLastTurnOutcome(chatId, "userStopped")');
    const teardown = body.indexOf("await interruptActiveStream(chatId)");
    expect(mark).toBeGreaterThan(-1);
    expect(teardown).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(teardown);
  });

  it("clears the outcome on Resume and on a real user send", () => {
    const clears = agent.match(/setLastTurnOutcome\([^)]*undefined\)/g);
    expect(clears?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("does not clear the outcome for a hidden continue message", () => {
    // Clearing on every send would let the retry loop clear its own brake.
    const guarded = agent.match(
      /if \(!isHiddenContinueUserMessage\(message\)\)[\s\S]{0,220}?setLastTurnOutcome\([^)]*undefined\)/,
    );
    expect(guarded).not.toBeNull();
  });

  it("passes the outcome into the guard at the deciding call site", () => {
    // ChatContainer's call only logs; this one gates the request.
    const body = agent.slice(agent.indexOf("shouldAutoContinueInterruptedTurn({"));
    expect(body.slice(0, 900)).toContain("lastTurnOutcome");
    expect(body.slice(0, 900)).toContain("streamRecoveryReason");
  });
});
