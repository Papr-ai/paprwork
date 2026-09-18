/**
 * Search-outcome feedback must be scoped PER RUN, not per process.
 *
 * WHY THESE TESTS EXIST
 * ---------------------
 * The registry used to be a single module-level array. Agent jobs and
 * subagents execute in the gateway process (AgentJobExecutor →
 * getAgentService() → runIsolatedJobSession → streamAgent), and streamAgent
 * calls `resetSearchOutcomes()` on entry. So the moment a chat turn delegated:
 *
 *     chat turn starts        -> reset, records searches s1..sn
 *     delegate_task fires     -> subagent job -> streamAgent -> RESET
 *                                ^ the parent turn's s1..sn are now gone
 *     chat turn ends          -> flush finds nothing, submits nothing
 *
 * and in the interleaved case the parent's searches were graded against the
 * SUBAGENT's answer, minting citations for text that could not have used them.
 * That is a wrong-label bug, not a missing-label bug, which is worse: it is
 * indistinguishable from real data downstream.
 *
 * Measured consequence: 234k queries in QueryLog produced 44 UserFeedbackLog
 * rows, of which only 6 carried `feedbackSource: "session_end"` — the source
 * this pipeline emits.
 *
 * Every test below fails against the pre-fix module-global implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { runWithToolContext } from "../src/core/tools/context.js";
import {
  flushSearchOutcomeFeedback,
  getPendingSearchOutcomes,
  markSearchOutcomeSubmitted,
  recordSearchOutcome,
  resetSearchOutcomes,
  type FeedbackSubmitter,
  type RecordedSearch,
} from "../src/core/utils/searchOutcomeFeedback.js";

const CHAT_RUN = "chat-abc";
const JOB_RUN = "job:job-1:run-1";

/** Candidate whose distinctive terms are unambiguous, so citation is decidable. */
function search(searchId: string, marker: string): RecordedSearch {
  return {
    searchId,
    memoryCount: 1,
    nodeCount: 0,
    candidatesKnown: true,
    candidates: [
      {
        id: `mem-${searchId}`,
        rank: 0,
        content:
          `${marker} quarterly reconciliation ledger variance ` +
          `${marker} depreciation schedule amortisation`,
      },
    ],
  };
}

function submitter(): FeedbackSubmitter & { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    feedback: {
      submit: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return {};
      },
    },
  };
}

describe("search-outcome registry is scoped per run", () => {
  beforeEach(() => {
    resetSearchOutcomes(CHAT_RUN);
    resetSearchOutcomes(JOB_RUN);
  });

  it("keeps two concurrent runs' searches apart", () => {
    recordSearchOutcome(search("s-chat", "alpaca"), CHAT_RUN);
    recordSearchOutcome(search("s-job", "bison"), JOB_RUN);

    expect(getPendingSearchOutcomes(CHAT_RUN).map((s) => s.searchId)).toEqual([
      "s-chat",
    ]);
    expect(getPendingSearchOutcomes(JOB_RUN).map((s) => s.searchId)).toEqual([
      "s-job",
    ]);
  });

  it("a subagent run's reset does NOT wipe the parent turn's searches", () => {
    recordSearchOutcome(search("s-chat", "alpaca"), CHAT_RUN);

    // delegate_task → subagent job → streamAgent → resetSearchOutcomes()
    resetSearchOutcomes(JOB_RUN);

    expect(getPendingSearchOutcomes(CHAT_RUN)).toHaveLength(1);
  });

  it("does not grade one run's searches against another run's answer", async () => {
    recordSearchOutcome(search("s-chat", "alpaca"), CHAT_RUN);
    recordSearchOutcome(search("s-job", "bison"), JOB_RUN);

    const client = submitter();
    // The chat answer reuses the CHAT candidate's distinctive terms only.
    const result = await flushSearchOutcomeFeedback(
      client,
      "alpaca quarterly reconciliation ledger variance depreciation schedule",
      {},
      CHAT_RUN,
    );

    expect(result.submitted).toBe(1);
    expect(client.bodies).toHaveLength(1);
    expect(client.bodies[0].search_id).toBe("s-chat");

    // The job's search is untouched and still awaits its own answer.
    expect(getPendingSearchOutcomes(JOB_RUN).map((s) => s.searchId)).toEqual([
      "s-job",
    ]);
  });

  it("a job's submitted id cannot suppress a chat's submission", async () => {
    // Same searchId in both runs is contrived, but it is exactly what a global
    // `submittedSearchIds` set could not distinguish.
    recordSearchOutcome(search("dup", "alpaca"), CHAT_RUN);
    markSearchOutcomeSubmitted("dup", JOB_RUN);

    const client = submitter();
    const result = await flushSearchOutcomeFeedback(
      client,
      "alpaca quarterly reconciliation ledger variance depreciation schedule",
      {},
      CHAT_RUN,
    );

    expect(result.submitted).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("still suppresses a double submit WITHIN one run", async () => {
    recordSearchOutcome(search("s1", "alpaca"), CHAT_RUN);
    markSearchOutcomeSubmitted("s1", CHAT_RUN);

    const client = submitter();
    const result = await flushSearchOutcomeFeedback(client, "anything", {}, CHAT_RUN);

    expect(result.submitted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(client.bodies).toHaveLength(0);
  });

  it("derives the run key from tool context when not passed explicitly", async () => {
    // This is how production works: the search tool never passes a run key,
    // it inherits the AsyncLocalStorage chatId set by streamAgent /
    // AgentJobExecutor. If that inheritance breaks, records land under a
    // different key than the flush reads and every label is silently lost.
    await runWithToolContext(JOB_RUN, () => {
      recordSearchOutcome(search("s-ambient", "bison"));
    });

    expect(getPendingSearchOutcomes(JOB_RUN).map((s) => s.searchId)).toEqual([
      "s-ambient",
    ]);
    expect(getPendingSearchOutcomes(CHAT_RUN)).toHaveLength(0);

    const client = submitter();
    const result = await flushSearchOutcomeFeedback(
      client,
      "bison quarterly reconciliation ledger variance depreciation schedule",
      {},
      JOB_RUN,
    );
    expect(result.submitted).toBe(1);
  });

  it("flush on a run with no searches is a no-op, not an error", async () => {
    const client = submitter();
    const result = await flushSearchOutcomeFeedback(client, "answer", {}, "unknown-run");
    expect(result).toEqual({ submitted: 0, skipped: 0, grades: [] });
  });
});
