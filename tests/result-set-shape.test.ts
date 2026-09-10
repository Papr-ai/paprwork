import { describe, it, expect } from "vitest";
import {
  analyzeResultSetShape,
  describeResultSetShape,
  normalizeForDedupe,
} from "../src/core/utils/resultSetShape.js";
import {
  deriveCitations,
  gradeSearchOutcome,
  type RecordedSearch,
  type RetrievedCandidate,
} from "../src/core/utils/searchOutcomeFeedback.js";

const candidate = (
  id: string,
  content: string,
  rank: number,
): RetrievedCandidate => ({ id, content, rank });

const search = (candidates: RetrievedCandidate[]): RecordedSearch => ({
  searchId: "search-1",
  memoryCount: candidates.length,
  nodeCount: 0,
  candidatesKnown: true,
  candidates,
});

/**
 * Observed in production: 98 of 110 `db.ts` files across 147 mini-apps are
 * byte-identical once the APP_ID line is removed. Search returned three of them
 * at ranks 1-3 with similarity 0.7042999 / 0.7041931 (equal to 4dp).
 */
const dbBoilerplate = (appId: string): string =>
  `const APP_ID = '${appId}';\n\n` +
  `export async function query<T>(sql: string, params: unknown[] = [], sourceId: string): Promise<T[]> {\n` +
  `  const res = await fetch('/api/db/query', {\n` +
  `    method: 'POST',\n` +
  `    headers: { 'Content-Type': 'application/json' },\n` +
  `    body: JSON.stringify({ appId: APP_ID, sourceId, sql, params }),\n` +
  `  });\n` +
  `  return (await res.json()).rows ?? [];\n}\n`;

const BOILERPLATE_IDS = [
  "a0de69a2-de82-4bd0-9fb2-355f727bd498",
  "67d4a03e-9ebc-48ca-b798-463b1aa7d3ad",
  "665db01d-31a4-47af-9a0f-c27ba0d36199",
];

describe("normalizeForDedupe", () => {
  it("collapses generated scaffolding that differs only by UUID", () => {
    const [a, b] = BOILERPLATE_IDS;
    expect(normalizeForDedupe(dbBoilerplate(a!))).toBe(
      normalizeForDedupe(dbBoilerplate(b!)),
    );
  });

  it("keeps genuinely different code distinct", () => {
    expect(normalizeForDedupe("export function renderChart() {}")).not.toBe(
      normalizeForDedupe("export function parseInvoice() {}"),
    );
  });
});

describe("analyzeResultSetShape", () => {
  it("flags the db.ts boilerplate flood despite differing UUIDs", () => {
    const shape = analyzeResultSetShape(
      BOILERPLATE_IDS.map((appId, i) =>
        candidate(`mem-${i}`, dbBoilerplate(appId), i),
      ),
    );

    // Exact hashing would report 3 distinct items here. Normalisation is what
    // makes this detectable at all.
    expect(shape.distinctContents).toBe(1);
    expect(shape.maxRepeat).toBe(3);
    expect(shape.duplicateRatio).toBeCloseTo(0.667, 2);
    expect(shape.idFanOut).toBe(false);
    expect(shape.degenerate).toBe(true);
  });

  it("flags server hydration fan-out when one id repeats", () => {
    // Observed: 20 rows collapsing to a single memory id, every
    // similarity_score equal to 0.5973358 at 7dp.
    const shape = analyzeResultSetShape(
      Array.from({ length: 20 }, (_, i) =>
        candidate("0dfe9a25-2720-4b1e-91d7-1772cc44aa29", "ctx blob", i),
      ),
    );

    expect(shape.distinctIds).toBe(1);
    expect(shape.idFanOut).toBe(true);
    expect(shape.degenerate).toBe(true);
    expect(describeResultSetShape(shape)).toContain("SERVER BUG");
  });

  it("does not flag a healthy diverse result set", () => {
    const shape = analyzeResultSetShape([
      candidate("a", "Turso replica sidecar wedge resets on reconnect", 0),
      candidate("b", "Quarterly revenue grew after the pricing change", 1),
      candidate("c", "The scheduler retries failed jobs with backoff", 2),
    ]);

    expect(shape.degenerate).toBe(false);
    expect(shape.duplicateRatio).toBe(0);
    expect(describeResultSetShape(shape)).toBeNull();
  });

  it("never calls a single result degenerate", () => {
    const shape = analyzeResultSetShape([candidate("a", "only one", 0)]);
    expect(shape.degenerate).toBe(false);
  });

  it("handles an empty result set without dividing by zero", () => {
    const shape = analyzeResultSetShape([]);
    expect(shape.total).toBe(0);
    expect(shape.duplicateRatio).toBe(0);
    expect(shape.degenerate).toBe(false);
  });
});

describe("gradeSearchOutcome — degeneracy", () => {
  it("caps a top-rank citation when the set was mostly duplicates", () => {
    // TWO boilerplate families, which is what a scaffolding-heavy corpus
    // actually returns. This matters: a single family large enough to make the
    // set degenerate (>50% repeats) would also exceed the distinctive-term
    // document-frequency ceiling and become uncitable, so the cap could never
    // be exercised. Two families keep each below the ceiling while the set as a
    // whole stays degenerate.
    const candidates: RetrievedCandidate[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        candidate(`db-${i}`, dbBoilerplate(`0000000${i}-de82-4bd0-9fb2-355f727bd498`), i),
      ),
      // Identical bodies under distinct ids — the same generated scene helper
      // copied into five apps. (Suffixing the function name instead would make
      // these genuinely distinct: the digit sits inside an identifier, so the
      // bare-integer normalisation correctly does not collapse it.)
      ...Array.from({ length: 5 }, (_, i) =>
        candidate(
          `scene-${i}`,
          "export function renderScene(host: HTMLElement) { host.innerHTML = template; }",
          5 + i,
        ),
      ),
      candidate("other-1", "Scheduler retries failed jobs using exponential backoff", 10),
      candidate("other-2", "Invoice parser normalises supplier tax identifiers", 11),
    ];

    const answer =
      "Mini-apps read rows by posting sql and params to /api/db/query with a sourceId, " +
      "then take the rows array off the JSON response.";

    const derivation = deriveCitations(answer, candidates);
    const grade = gradeSearchOutcome(search(candidates), derivation);

    expect(derivation.bestCitedRank).toBe(0);
    expect(grade.verdict).toBe("cited_top_rank");
    // Uncapped this would be a 5 — a perfect score for a flood.
    expect(grade.score).toBe(3);
    expect(grade.feedbackText).toContain("capped=degenerate");
    expect(grade.feedbackText).toContain("rank_score=5");
    expect(grade.shape?.degenerate).toBe(true);
  });

  it("leaves a healthy top-rank citation at 5", () => {
    const candidates = [
      candidate(
        "a",
        "The Turso replica sidecar wedge is reset by reconnecting; watermark frames realign automatically.",
        0,
      ),
      candidate("b", "Quarterly revenue for the Helsinki office grew after repricing.", 1),
      candidate("c", "Scheduler retries failed jobs using exponential backoff.", 2),
    ];
    const answer =
      "The sidecar wedge resets on reconnect — the watermark frames realign, so no manual repair is needed.";

    const grade = gradeSearchOutcome(
      search(candidates),
      deriveCitations(answer, candidates),
    );

    expect(grade.verdict).toBe("cited_top_rank");
    expect(grade.score).toBe(5);
    expect(grade.feedbackText).not.toContain("capped=degenerate");
  });

  it("grades an uncited pure flood as retrieved_degenerate, not citations_unknown", () => {
    // In a pure flood every term has document frequency 1.0, so the
    // distinctive-term filter strips everything and judgeableCount hits 0.
    // That must NOT be reported as "unknown" — the cause is fully known.
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate(`dup-${i}`, dbBoilerplate(BOILERPLATE_IDS[0]!), i),
    );

    const derivation = deriveCitations(
      "Nothing in these results answered the question.",
      candidates,
    );
    const grade = gradeSearchOutcome(search(candidates), derivation);

    expect(derivation.judgeableCount).toBe(0);
    expect(grade.verdict).toBe("retrieved_degenerate");
    expect(grade.score).toBe(1);
    expect(grade.feedbackText).toContain("dup_ratio=0.9");
    expect(grade.feedbackText).toContain("max_repeat=10");
  });

  it("keeps an ordinary ranking miss at retrieved_unused", () => {
    const candidates = [
      candidate("a", "Quarterly revenue for the Helsinki office grew after repricing.", 0),
      candidate("b", "Scheduler retries failed jobs using exponential backoff.", 1),
      candidate("c", "Invoice parser normalises supplier tax identifiers.", 2),
    ];

    const grade = gradeSearchOutcome(
      search(candidates),
      deriveCitations("None of this was relevant to the question asked.", candidates),
    );

    expect(grade.verdict).toBe("retrieved_unused");
    expect(grade.score).toBe(2);
    expect(grade.shape?.degenerate).toBe(false);
  });

  it("reports no shape when the payload could not be parsed", () => {
    const grade = gradeSearchOutcome(
      { ...search([]), candidatesKnown: false, memoryCount: 8 },
      deriveCitations("anything", []),
    );

    expect(grade.verdict).toBe("citations_unknown");
    expect(grade.shape).toBeNull();
  });
});
