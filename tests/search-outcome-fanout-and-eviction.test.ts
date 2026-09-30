/**
 * Two label-corruption bugs found by exercising the BUILT artifact against the
 * interleavings a real session produces, rather than the ones the unit tests
 * happened to cover.
 *
 * 1. ID FAN-OUT DUPLICATED POSITIVES
 *    One memory returned at several ranks produced one citation per ROW, so
 *    `citedMemoryIds` could contain the same id twice. Confirmed in production:
 *    UserFeedbackLog row d77a41cd carried
 *      cited=2  citedMemoryIds=['1e432d82-…','1e432d82-…']
 *    for a single document. A trainer reading that counts one piece of evidence
 *    twice.
 *
 * 2. EVICTION DROPPED THE RUN MOST LIKELY TO STILL NEED ITS LABELS
 *    The registry evicted in insertion order, i.e. oldest-first. The oldest
 *    entry is normally the long-lived chat turn still collecting searches; the
 *    newest are short subagent runs. A turn that searched and then delegated
 *    past the cap lost its own ungraded searches — silently. Silence is how the
 *    original global-registry bug survived, so the replacement warns.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_TRACKED_RUNS,
  deriveCitations,
  flushSearchOutcomeFeedback,
  getPendingSearchOutcomes,
  recordSearchOutcome,
  resetSearchOutcomes,
  type FeedbackSubmitter,
  type RetrievedCandidate,
} from "../src/core/utils/searchOutcomeFeedback.js";

const TURN = "chat-long-turn";

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

/** Same memory id at three ranks — what an id fan-out actually looks like. */
function fanOut(id: string): RetrievedCandidate[] {
  const content =
    "reconciliation ledger variance depreciation amortisation schedule";
  return [0, 1, 2].map((rank) => ({ id, rank, content }));
}

describe("id fan-out must not duplicate positives", () => {
  const answer =
    "reconciliation ledger variance depreciation amortisation schedule";

  it("emits each cited memory id at most once", () => {
    const d = deriveCitations(answer, fanOut("mem-same"));
    expect(d.citedIds).toEqual(["mem-same"]);
    expect(d.citedIds.length).toBe(new Set(d.citedIds).size);
  });

  it("credits the BEST rank when the same memory appears at several", () => {
    const shuffled = [
      { id: "m", rank: 7, content: answer },
      { id: "m", rank: 2, content: answer },
      { id: "m", rank: 9, content: answer },
    ];
    expect(deriveCitations(answer, shuffled).bestCitedRank).toBe(2);
  });

  it("prefers an explicit id mention over term overlap for the same memory", () => {
    const id = "mem-explicit-1234";
    const d = deriveCitations(`${answer} ${id}`, [
      { id, rank: 5, content: answer },
      { id, rank: 1, content: answer },
    ]);
    expect(d.citations).toHaveLength(1);
    expect(d.citations[0].method).toBe("explicit_id");
  });

  it("submits deduplicated citedMemoryIds and a matching cited count", async () => {
    resetSearchOutcomes("fanout");
    recordSearchOutcome(
      {
        searchId: "s-fan",
        memoryCount: 3,
        nodeCount: 0,
        candidatesKnown: true,
        candidates: fanOut("mem-same"),
      },
      "fanout",
    );
    const client = submitter();
    await flushSearchOutcomeFeedback(client, answer, {}, "fanout");

    const data = client.bodies[0].feedbackData as {
      citedMemoryIds: string[];
      feedbackText: string;
    };
    expect(data.citedMemoryIds).toEqual(["mem-same"]);
    // The count in the telemetry must agree with the ids actually submitted —
    // it previously said cited=3 for one document.
    expect(data.feedbackText).toContain("cited=1");
  });

  it("still reports genuinely distinct cited memories separately", () => {
    // Guard against "fixing" duplication by collapsing everything.
    const d = deriveCitations(
      "alpaca reconciliation ledger variance depreciation amortisation " +
        "bison kubernetes sharding quantisation telemetry autoscaler",
      [
        {
          id: "m1",
          rank: 0,
          content:
            "alpaca reconciliation ledger variance depreciation amortisation",
        },
        {
          id: "m2",
          rank: 1,
          content:
            "bison kubernetes sharding quantisation telemetry autoscaler",
        },
      ],
    );
    expect(new Set(d.citedIds)).toEqual(new Set(["m1", "m2"]));
  });
});

describe("registry eviction protects ungraded labels", () => {
  beforeEach(() => resetSearchOutcomes(TURN));

  const search = (searchId: string) => ({
    searchId,
    memoryCount: 1,
    nodeCount: 0,
    candidatesKnown: true,
    candidates: [
      { id: `mem-${searchId}`, rank: 0, content: "ledger variance schedule" },
    ],
  });

  it("keeps a long-lived turn's searches through a delegation burst", () => {
    recordSearchOutcome(search("s-turn"), TURN);

    // Each delegate_task creates a fresh run key. Push well past the cap.
    for (let i = 0; i < MAX_TRACKED_RUNS + 16; i++) {
      const jobRun = `job:burst-${i}:run-1`;
      recordSearchOutcome(search(`s-job-${i}`), jobRun);
      // Jobs flush when they finish, which drains them — these are the entries
      // eviction should prefer, and the reason the turn now survives.
      resetSearchOutcomes(jobRun);
    }

    expect(getPendingSearchOutcomes(TURN).map((s) => s.searchId)).toEqual([
      "s-turn",
    ]);
  });

  it("evicts a drained run before one that still owes labels", async () => {
    recordSearchOutcome(search("s-keep"), TURN);

    // A run that has already flushed: pending empty, submitted set retained.
    recordSearchOutcome(search("s-done"), "run-drained");
    await flushSearchOutcomeFeedback(submitter(), "ledger variance schedule", {}, "run-drained");
    expect(getPendingSearchOutcomes("run-drained")).toHaveLength(0);

    for (let i = 0; i < MAX_TRACKED_RUNS + 4; i++) {
      recordSearchOutcome(search(`s-f-${i}`), `job:filler-${i}`);
      resetSearchOutcomes(`job:filler-${i}`);
    }

    expect(getPendingSearchOutcomes(TURN)).toHaveLength(1);
  });
});
