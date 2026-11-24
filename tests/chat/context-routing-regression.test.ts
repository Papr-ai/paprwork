/**
 * Regression guard for how Pen gets context in non-coding and chat-history work.
 *
 * The code-search hooks (papr-embed pointers, Jev rerank, device hits) must only fire on code greps
 * (apps/, Jobs/, documents/, workspace/, repos/). Greps over the chat export, chats.db or arbitrary folders
 * must stay plain grep, so recalling earlier chat context never gets code pointers mixed in.
 */
import { describe, expect, test } from "vitest";
import { detectPaprContextGrepCommand, detectPaprGrepCommand } from "../../src/core/tools/bash.js";
import { CURRENT_CHAT_SCOPE, resolveConversationId } from "../../src/core/tools/chatScope.js";
import { runWithToolContext } from "../../src/core/tools/context.js";
import { formatSummaryForLLM } from "../../src/gateway/services/storage/summaryFormatting.js";
import {
  computeRecentMessageLimit,
  RECENT_MESSAGES_MAX,
  RECENT_MESSAGES_MIN,
} from "../../src/gateway/services/storage/recentMessageWindow.js";

const NS = "/Users/u/Papr/orgs/O1/namespaces/N1";

describe("code-search hooks stay off chat-history and non-code greps", () => {
  test.each([
    `grep -n -i "coreml" "${NS}/Chats/Update Samir Status.txt"`,
    `grep -rn "investor" ${NS}/Chats/`,
    `grep -c "Samir" ~/notes/meeting.md`,
    `sqlite3 "file:${NS}/chats.db?mode=ro" "select summary_long from chats"`,
  ])("plain grep: %s", (cmd) => {
    expect(detectPaprGrepCommand(cmd)).toBeNull();
    expect(detectPaprContextGrepCommand(cmd)).toBeNull();
  });

  test("app and job code greps still get code pointers", () => {
    expect(detectPaprGrepCommand(`grep -rn "loadData" ${NS}/apps/eb6a1b9f-59e0-4210-b47f-eddeaf816487/`)).not.toBeNull();
    expect(detectPaprGrepCommand(`grep -rn "def main" ${NS}/Jobs/c1e15a5b-10a2-46a1-ae7c-abf4bef4932d/code/`)).not.toBeNull();
  });

  test("documents/ and workspace/ greps get on-device semantic hits, not app pointers", () => {
    const cmd = `grep -rn "moat" ${NS}/documents/`;
    expect(detectPaprGrepCommand(cmd)).toBeNull();
    expect(detectPaprContextGrepCommand(cmd)).toEqual({ pattern: "moat", path: `${NS}/documents/` });
  });
});

describe("in-chat recall paths stay wired", () => {
  test("the summary block tells the agent both ways back to older turns", () => {
    const s = formatSummaryForLLM({
      tiers: { short_term: "s", medium_term: "m", long_term: "l", topics: [], last_updated: "" },
      chatFilePath: `${NS}/Chats/My chat.txt`,
    });
    expect(s).toContain(`Full conversation export: ${NS}/Chats/My chat.txt`);
    expect(s).toContain('chatId: "current_chat"');
  });

  test("current_chat resolves to the active chat for search_agent_memory / get_full_tool_result", () => {
    expect(runWithToolContext("chat-9", () => resolveConversationId(CURRENT_CHAT_SCOPE))).toBe("chat-9");
  });

  test("recent raw turns after a summary stay within the 10-20 window", () => {
    for (let n = 0; n < 40; n++) {
      const k = computeRecentMessageLimit(600 + n, 600);
      expect(k).toBeGreaterThanOrEqual(RECENT_MESSAGES_MIN);
      expect(k).toBeLessThanOrEqual(RECENT_MESSAGES_MAX);
    }
  });
});
