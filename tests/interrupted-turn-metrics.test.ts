/**
 * An interrupted turn must still record its measurements.
 *
 * The write used to sit after the final message save inside `streamAgent`'s
 * happy path, so an abort threw straight past it into the catch. That left a
 * row with a billed total and no peak — and a missing peak is not a neutral
 * gap. `getContextMeter` reads it as "fall back to the billed total", and
 * since usage became a cross-step sum (Issue 91) that total is several times
 * the size of any single request; clamped by `Math.min(..., effectiveWindow)`
 * it lands on exactly the window and the ring reads exactly 100%.
 *
 * Measured on the live workspace when this was found: 24 of 52 billed turns
 * since the metrics migration had a null peak, and the newest was a $3.04
 * interrupted opus-5 turn whose billed sum was 4,157,052 against a 1.0M
 * window. So this is the common case for long turns, not an edge.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createTurnMetrics,
  recordObservedContext,
  recordStep,
  setToolCallCount,
  summarizeTurnMetrics,
} from "../src/gateway/services/agent/turnMetrics.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT_SERVICE = "src/gateway/services/AgentService.ts";

/**
 * Read the source with comments removed.
 *
 * Without this the guard is defeated by the most likely regression there is:
 * commenting the call out leaves the anchor text in the file, `indexOf` finds
 * it, and every assertion below passes against code that no longer runs.
 * Verified by doing exactly that — all eight tests stayed green.
 *
 * Block comments go first (the JSDoc above each helper quotes these anchors by
 * name), then whole-line `//`. Trailing comments are left alone deliberately:
 * stripping them needs string-literal awareness, and this file is full of URLs
 * and messages containing `//`.
 */
function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.join(ROOT, relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Resolve an anchor or fail naming it.
 *
 * A bare `indexOf` that misses returns -1, and every ordering comparison built
 * on it then compares against -1 — which passes for "appears after" roughly
 * half the time. The guard would report success while checking nothing, which
 * is the failure mode #181 fixed in the workspace-switch invariants.
 */
function requireIndex(content: string, anchor: string, label: string): number {
  const index = content.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `${label} not found in ${AGENT_SERVICE}: ${JSON.stringify(anchor)} — ` +
        `the code was renamed or rewrapped. Update the anchor, never delete ` +
        `the invariant.`,
    );
  }
  return index;
}

/**
 * Narrow the file to `streamAgent` before comparing offsets.
 *
 * Learned the hard way writing this: `\n    try {` matches a different
 * method's try block 14,000 characters earlier, so an unscoped search made the
 * declaration look like it came *after* the try and failed an invariant that
 * held. Anchors have to be unique within the text actually being searched.
 */
function streamAgentBody(source: string): string {
  const start = requireIndex(source, "async *streamAgent(", "streamAgent");
  const end = requireIndex(
    source,
    "async getContextMeter(",
    "the method after streamAgent (slice end)",
  );
  if (end <= start) {
    throw new Error(
      `[${AGENT_SERVICE}] getContextMeter now precedes streamAgent — the ` +
        `slice would be empty and every assertion below would pass vacuously`,
    );
  }
  return source.slice(start, end);
}

describe("partial metrics from an interrupted turn", () => {
  it("summarizes to a usable peak, which is what spares the meter the billed fallback", () => {
    // Three steps in, then the user stops it: exactly the shape the screenshot
    // came from.
    const metrics = createTurnMetrics();
    recordStep(metrics, { estimatedTokens: 90_000, historyTokenBudget: 15_971 });
    recordObservedContext(metrics, 121_400);
    recordStep(metrics, { estimatedTokens: 140_000 });
    recordObservedContext(metrics, 228_084);
    recordStep(metrics, { estimatedTokens: 160_000 });
    setToolCallCount(metrics, 5);

    const summary = summarizeTurnMetrics(metrics);

    // The peak is the largest SINGLE request, not a sum — 228,084, not
    // 121,400 + 228,084. Getting this wrong is how the billed total came to
    // stand in for fullness in the first place.
    expect(summary.peakContextTokens).toBe(228_084);
    expect(summary.steps).toBe(3);
    expect(summary.toolCalls).toBe(5);
    expect(summary.historyTokenBudget).toBe(15_971);
  });

  it("records a peak even when the turn aborted before any tool ran", () => {
    const metrics = createTurnMetrics();
    recordStep(metrics, { estimatedTokens: 84_000 });
    recordObservedContext(metrics, 104_007);
    setToolCallCount(metrics, 0);

    const summary = summarizeTurnMetrics(metrics);

    expect(summary.peakContextTokens).toBe(104_007);
    // Null rather than 0: no tool calls means the rate has no denominator, and
    // 0 would read as "measured, and it was zero".
    expect(summary.toolCallsPerStep).toBe(0);
    expect(summary.redundantRecoveryRate).toBeNull();
  });

  it("leaves the peak at zero when not one step landed, so the row stays honest", () => {
    // A turn killed before its first step has nothing to report, and inventing
    // a peak here would be worse than the gap — the meter would show a
    // confident number for a request that never went out.
    const summary = summarizeTurnMetrics(createTurnMetrics());

    expect(summary.peakContextTokens).toBe(0);
    expect(summary.steps).toBe(0);
    expect(summary.contextFillRatio).toBeNull();
  });
});

describe("streamAgent records metrics on the interrupted path", () => {
  const body = streamAgentBody(readCode(AGENT_SERVICE));

  it("calls the recorder from finally, strictly after the row it annotates is written", () => {
    const persist = requireIndex(
      body,
      "await persistIncompleteAssistant({ asAbort: true });",
      "finally-path persist",
    );
    const record = requireIndex(
      body,
      'await recordTurnMetricsOnce("interrupted")',
      "finally-path metrics recording",
    );

    // Ordering is the whole invariant: on this path `persistIncompleteAssistant`
    // is what creates the row, so recording first would annotate nothing.
    expect(record).toBeGreaterThan(persist);
  });

  it("is idempotent, so the happy path and finally cannot both write", () => {
    const declaration = requireIndex(
      body,
      "const recordTurnMetricsOnce = async (",
      "recorder declaration",
    );
    const head = body.slice(declaration, declaration + 400);

    // Flag checked and set before the first await, so two callers racing
    // cannot both get past it.
    expect(head).toContain("if (turnMetricsRecorded) return;");
    expect(head).toContain("turnMetricsRecorded = true;");
    expect(head.indexOf("turnMetricsRecorded = true;")).toBeLessThan(
      head.indexOf("await"),
    );
  });

  it("declares the metrics outside the try, or finally could not reach them", () => {
    const declaration = requireIndex(
      body,
      "const turnMetrics = createTurnMetrics();",
      "turnMetrics declaration",
    );
    const tryStart = requireIndex(body, "\n    try {", "streamAgent try block");

    expect(declaration).toBeLessThan(tryStart);

    // And exactly one of them — a second `createTurnMetrics()` inside the try
    // would shadow this and quietly restore the original bug, with the
    // finally left holding an untouched object it would report as an empty
    // turn.
    const occurrences =
      body.split("const turnMetrics = createTurnMetrics();").length - 1;
    expect(occurrences).toBe(1);
  });

  it("seeds turnStartedAt at declaration so an early abort cannot report the Unix epoch", () => {
    const declaration = requireIndex(
      body,
      "let turnStartedAt = Date.now();",
      "turnStartedAt declaration",
    );
    const tryStart = requireIndex(body, "\n    try {", "streamAgent try block");

    expect(declaration).toBeLessThan(tryStart);

    // Re-anchored at the first step, which keeps the duration measuring the
    // same span it always did rather than including turn setup.
    const reAnchor = requireIndex(
      body,
      "\n      turnStartedAt = Date.now();",
      "turnStartedAt re-anchor at first step",
    );
    expect(reAnchor).toBeGreaterThan(tryStart);
  });

  it("marks the interrupted path in telemetry rather than passing it off as completed", () => {
    // Interrupted turns are the longest ones, so dropping them biases every
    // aggregate downward while folding them in silently overstates completion.
    expect(body).toContain('interrupted: outcome === "interrupted"');
    expect(body).toContain('await recordTurnMetricsOnce("completed")');
  });
});
