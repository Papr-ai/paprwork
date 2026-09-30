import { describe, expect, it } from "vitest";
import {
  categorizeTool,
  isFullRetentionTool,
  isMidTurnUncappedTool,
  resolveHistoryToolResultCharLimit,
  resolveMidTurnToolResultCharLimit,
  truncateToolResultForModelContext,
  type HistoryMessageLike,
} from "../src/gateway/services/agent/toolResultTruncation.js";

/** History where the tool result at index 0 is followed by `userTurns` user turns. */
function historyWithUserTurns(userTurns: number): HistoryMessageLike[] {
  const history: HistoryMessageLike[] = [{ role: "assistant" }];
  for (let i = 0; i < userTurns; i += 1) {
    history.push({ role: "user" }, { role: "assistant" });
  }
  return history;
}

function historyLimitFor(toolName: string, userTurns: number): number | null {
  return resolveHistoryToolResultCharLimit({
    toolName,
    toolCallId: "toolu_abc123",
    args: {},
    resultStr: "x".repeat(120_000),
    history: historyWithUserTurns(userTurns),
    messageIndex: 0,
    isOrphan: false,
  });
}

describe("get_full_tool_result retention", () => {
  it("arrives uncapped in the turn that requested it", () => {
    // Capping the recovery fetch in its own turn would defeat the tool.
    const huge = "x".repeat(200_000);
    expect(
      truncateToolResultForModelContext(huge, "toolu_abc123", "get_full_tool_result"),
    ).toBe(huge);
    expect(isMidTurnUncappedTool("get_full_tool_result")).toBe(true);
    expect(
      resolveMidTurnToolResultCharLimit("get_full_tool_result", 6_000),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is no longer exempt from truncation in cross-turn history", () => {
    // The regression: exempt everywhere and forever, so every recovery fetch
    // stayed resident at full size for the life of the chat.
    expect(isFullRetentionTool("get_full_tool_result")).toBe(false);
  });

  it("stays full inside the recent-turn window, then truncates", () => {
    expect(historyLimitFor("get_full_tool_result", 0)).toBe(40_000);
    expect(historyLimitFor("get_full_tool_result", 3)).toBe(40_000);

    const decayed = historyLimitFor("get_full_tool_result", 6);
    expect(decayed).not.toBeNull();
    expect(decayed!).toBeLessThan(40_000);
  });

  it("decays to the moderate limit, not its category's aggressive one", () => {
    // It is in the memory_search category, but a payload the agent explicitly
    // fetched decays more gently than a passive search hit: at the aggressive
    // limit a re-fetch costs the whole payload again.
    expect(categorizeTool("get_full_tool_result")).toBe("memory_search");

    const decayed = historyLimitFor("get_full_tool_result", 6)!;
    const passiveSearch = historyLimitFor("search_agent_memory", 6)!;
    expect(decayed).toBeGreaterThan(passiveSearch);

    // At or below 2000 chars truncation is deterministic head+tail, so the agent
    // sees both ends of what it fetched and can judge whether to re-fetch.
    expect(decayed).toBeLessThanOrEqual(2000);
  });

  it("leaves delegation status exempt everywhere", () => {
    // get_delegation_run must survive verbatim: it is read for status, not recoverable.
    expect(isFullRetentionTool("get_delegation_run")).toBe(true);
    expect(isMidTurnUncappedTool("get_delegation_run")).toBe(true);
    expect(historyLimitFor("get_delegation_run", 99)).toBeNull();
  });

  it("leaves file reads full, so the prompt cache is unaffected", () => {
    expect(historyLimitFor("read_file", 99)).toBe(40_000);
    expect(historyLimitFor("read_app_file", 99)).toBe(40_000);
  });

  it("still truncates an unrelated noisy tool immediately", () => {
    const bashLimit = historyLimitFor("bash", 6);
    expect(bashLimit).not.toBeNull();
    expect(bashLimit!).toBeLessThan(40_000);
  });

  it("keeps an orphaned result whole regardless of age", () => {
    expect(
      resolveHistoryToolResultCharLimit({
        toolName: "get_full_tool_result",
        toolCallId: "toolu_abc123",
        args: {},
        resultStr: "x".repeat(120_000),
        history: historyWithUserTurns(50),
        messageIndex: 0,
        isOrphan: true,
      }),
    ).toBeNull();
  });
});
