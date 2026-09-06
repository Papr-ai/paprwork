import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  deriveCitations,
  gradeSearchOutcome,
  flushSearchOutcomeFeedback,
  recordSearchOutcome,
  resetSearchOutcomes,
  markSearchOutcomeSubmitted,
  getPendingSearchOutcomes,
  type RecordedSearch,
  type RetrievedCandidate,
} from "../src/core/utils/searchOutcomeFeedback.js";
import { extractRetrievedCandidates } from "../src/core/tools/paprMemory.js";

const candidate = (
  id: string,
  content: string,
  rank: number,
): RetrievedCandidate => ({ id, content, rank });

const search = (over: Partial<RecordedSearch> = {}): RecordedSearch => ({
  searchId: "search-1",
  memoryCount: over.candidates?.length ?? 3,
  nodeCount: 0,
  candidatesKnown: true,
  candidates: [],
  ...over,
});

describe("deriveCitations", () => {
  it("marks a memory cited when its distinctive terms appear in the answer", () => {
    const candidates = [
      candidate(
        "mem-a",
        "The Turso replica sidecar wedge is reset by reconnecting; watermark frames realign automatically.",
        0,
      ),
      candidate(
        "mem-b",
        "Quarterly revenue for the Helsinki office grew after the pricing change.",
        1,
      ),
    ];
    const answer =
      "The sidecar wedge resets on reconnect — the watermark frames realign, so no manual repair is needed.";

    const result = deriveCitations(answer, candidates);

    expect(result.citedIds).toEqual(["mem-a"]);
    expect(result.bestCitedRank).toBe(0);
  });

  it("does NOT cite topically-similar candidates that were not used", () => {
    // The precision test that matters. Every result of one query shares the
    // query's vocabulary; if shared terms counted as evidence, all of them
    // would be marked cited and every search would look perfect.
    const candidates = [
      candidate(
        "used",
        "Neo4j relationship ACLs are written at creation via add_relationships_v2 using the props map.",
        0,
      ),
      candidate(
        "unused-1",
        "Neo4j relationship counts are served from the count store instantly.",
        1,
      ),
      candidate(
        "unused-2",
        "Neo4j relationship types number 1832 across the whole database.",
        2,
      ),
    ];
    const answer =
      "Relationship ACLs are written at creation through add_relationships_v2, which applies the props map.";

    const result = deriveCitations(answer, candidates);

    expect(result.citedIds).toEqual(["used"]);
    expect(result.citedIds).not.toContain("unused-1");
    expect(result.citedIds).not.toContain("unused-2");
  });

  it("treats an explicit id mention as a certain citation", () => {
    const candidates = [candidate("7cfa0072-cb31-4129", "unrelated wording", 4)];
    const result = deriveCitations(
      "See memory 7cfa0072-cb31-4129 for the details.",
      candidates,
    );

    expect(result.citedIds).toEqual(["7cfa0072-cb31-4129"]);
    expect(result.citations[0]?.method).toBe("explicit_id");
    expect(result.citations[0]?.confidence).toBe(1);
  });

  it("reports candidates with too little unique signal as un-judgeable, not unused", () => {
    // "Not judgeable" must not silently become a hard negative.
    const candidates = [candidate("thin", "ok yes", 0)];
    const result = deriveCitations("A long answer about something else.", candidates);

    expect(result.judgeableCount).toBe(0);
    expect(result.citedIds).toEqual([]);
  });

  it("returns empty for an empty answer", () => {
    const result = deriveCitations("", [candidate("a", "some content here", 0)]);
    expect(result.citedIds).toEqual([]);
    expect(result.bestCitedRank).toBeNull();
  });
});

describe("gradeSearchOutcome", () => {
  it("grades an empty search as score 1", () => {
    const grade = gradeSearchOutcome(
      search({ memoryCount: 0, nodeCount: 0 }),
      deriveCitations("anything", []),
    );
    expect(grade.verdict).toBe("no_results");
    expect(grade.score).toBe(1);
  });

  it("NEVER grades an unparsed payload as unused", () => {
    // The guard that keeps 'unknown' distinct from 'zero'. Grading an
    // unparsed response as retrieved_unused would emit a false negative for
    // every successful search whose payload shape we failed to read.
    const grade = gradeSearchOutcome(
      search({ memoryCount: 12, candidatesKnown: false, candidates: [] }),
      deriveCitations("some answer", []),
    );
    expect(grade.verdict).toBe("citations_unknown");
    expect(grade.verdict).not.toBe("retrieved_unused");
    expect(grade.score).toBe(3);
  });

  it("grades retrieved-but-unused as a weak negative", () => {
    const candidates = [
      candidate("a", "Helsinki pricing revenue quarterly office growth numbers", 0),
    ];
    const grade = gradeSearchOutcome(
      search({ memoryCount: 1, candidates }),
      deriveCitations("Completely unrelated answer about compiler flags.", candidates),
    );
    expect(grade.verdict).toBe("retrieved_unused");
    expect(grade.score).toBe(2);
  });

  it("scores by the rank of the best cited result", () => {
    const content =
      "sidecar wedge watermark realign reconnect replica frames repair";
    const answer =
      "The sidecar wedge and watermark realign on reconnect, so replica frames repair themselves.";

    const atTop = [candidate("m", content, 0)];
    const atMid = [candidate("m", content, 5)];
    const atDeep = [candidate("m", content, 17)];

    expect(
      gradeSearchOutcome(search({ candidates: atTop }), deriveCitations(answer, atTop))
        .score,
    ).toBe(5);
    expect(
      gradeSearchOutcome(search({ candidates: atMid }), deriveCitations(answer, atMid))
        .score,
    ).toBe(4);
    expect(
      gradeSearchOutcome(search({ candidates: atDeep }), deriveCitations(answer, atDeep))
        .score,
    ).toBe(3);
  });

  it("emits no memory content or query text in feedbackText (D2)", () => {
    const secret = "myhomeqrc@gmail.com and passphrase hunter2";
    const candidates = [candidate("a", `${secret} sidecar wedge watermark realign`, 0)];
    const grade = gradeSearchOutcome(
      search({ candidates }),
      deriveCitations("sidecar wedge watermark realign reconnect", candidates),
    );

    expect(grade.feedbackText).not.toContain("myhomeqrc");
    expect(grade.feedbackText).not.toContain("hunter2");
    expect(grade.feedbackText).toMatch(/^auto=search_outcome_v1( [a-z_]+=\S+)+$/);
  });
});

describe("flushSearchOutcomeFeedback", () => {
  beforeEach(() => resetSearchOutcomes());

  it("submits one graded row per recorded search", async () => {
    const submit = vi.fn().mockResolvedValue({});
    recordSearchOutcome(
      search({
        searchId: "s1",
        candidates: [candidate("a", "sidecar wedge watermark realign frames", 0)],
      }),
    );

    const result = await flushSearchOutcomeFeedback(
      { feedback: { submit } },
      "The sidecar wedge and watermark realign the frames.",
      { user_id: "u1" },
    );

    expect(result.submitted).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    const body = submit.mock.calls[0]![0] as Record<string, any>;
    expect(body.search_id).toBe("s1");
    expect(body.user_id).toBe("u1");
    expect(body.feedbackData.feedbackType).toBe("memory_relevance");
    expect(body.feedbackData.citedMemoryIds).toEqual(["a"]);
  });

  it("does not double-submit a search already graded inline", async () => {
    const submit = vi.fn().mockResolvedValue({});
    recordSearchOutcome(search({ searchId: "s2", memoryCount: 0, nodeCount: 0 }));
    markSearchOutcomeSubmitted("s2");

    const result = await flushSearchOutcomeFeedback(
      { feedback: { submit } },
      "answer",
    );

    expect(result.submitted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("swallows API errors — telemetry must never fail a turn", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("500 boom"));
    recordSearchOutcome(search({ searchId: "s3" }));

    await expect(
      flushSearchOutcomeFeedback({ feedback: { submit } }, "answer"),
    ).resolves.toMatchObject({ submitted: 0, skipped: 1 });
  });

  it("clears pending searches so the next turn starts empty", async () => {
    recordSearchOutcome(search({ searchId: "s4" }));
    expect(getPendingSearchOutcomes()).toHaveLength(1);
    await flushSearchOutcomeFeedback(
      { feedback: { submit: vi.fn().mockResolvedValue({}) } },
      "answer",
    );
    expect(getPendingSearchOutcomes()).toHaveLength(0);
  });
});

describe("extractRetrievedCandidates", () => {
  it("reads structured memories with their rank", () => {
    const result = extractRetrievedCandidates({
      data: { memories: [{ id: "m1", content: "first" }, { id: "m2", content: "second" }] },
    } as never);

    expect(result).toEqual([
      { id: "m1", content: "first", rank: 0 },
      { id: "m2", content: "second", rank: 1 },
    ]);
  });

  it("parses tabular TOON and keeps commas inside quoted content", () => {
    const toon = [
      "data:",
      "  memories[#2]{id,content}:",
      '    m1,"Parse, Qdrant, and Neo4j all carry ACLs"',
      "    m2,Second memory",
      "search_id: abc",
    ].join("\n");

    const result = extractRetrievedCandidates(toon);

    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      id: "m1",
      content: "Parse, Qdrant, and Neo4j all carry ACLs",
      rank: 0,
    });
    expect(result![1]!.content).toBe("Second memory");
  });

  it("returns null (unknown) when the shape has no field header", () => {
    // The count-only envelope used by existing TOON responses. Must be
    // 'unknown', never an empty candidate list.
    const result = extractRetrievedCandidates(
      "code: 200\nstatus: success\ndata:\n  memories[#10]:\nsearch_id: s",
    );
    expect(result).toBeNull();
  });
});
