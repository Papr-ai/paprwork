/**
 * Grade a finished agent run's memory searches against the answer it produced.
 *
 * WHY THIS IS A SHARED HELPER RATHER THAN INLINE CODE
 * --------------------------------------------------
 * The grading block used to live inline in `AgentService.streamAgent`, which
 * meant only the CHAT path produced retrieval labels. Measured on production
 * `QueryLog`: 50.2% of all searches carry an `=== JOB ENVIRONMENT ===` prompt,
 * i.e. they come from agent/subagent JOBS, and the three job entrypoints
 * (`runIsolatedJobSession`, `runStructuredJobSession`,
 * `streamIsolatedJobSessionForCloud`) never called the flush.
 *
 * So the single largest source of agent retrieval behaviour produced zero
 * labels. `UserFeedbackLog` held 44 rows against 234k queries — and only 6 of
 * those 44 were `session_end`, the source this pipeline emits.
 *
 * Every run that can search must therefore go through one function, so a new
 * entrypoint cannot silently opt out of labelling again.
 *
 * WHY IT NEVER THROWS
 * -------------------
 * Retrieval telemetry must not be able to fail a user's turn or a job run. All
 * failures are logged and swallowed; the caller uses `void` and moves on.
 */

import {
  flushSearchOutcomeFeedback,
  type FlushResult,
} from "../../../core/utils/searchOutcomeFeedback.js";

export interface GradeRunSearchOutcomesInput {
  /**
   * Run key. MUST be the same value the tool context saw during the run —
   * the chat id for chat turns, `job:{jobId}:{runId}` for job runs. Passing
   * the wrong key grades one run's searches against another run's answer.
   */
  runKey: string;
  /**
   * The text the agent actually produced. Citations are derived from this, so
   * an empty answer must never reach here: grading against empty text marks
   * every retrieved memory as unused and mints false negatives at scale.
   */
  answerText: string;
  /** Label for log lines, e.g. "chat" or "job:agent". */
  surface: string;
}

/**
 * Fire-and-forget. Returns the flush result for tests; callers should `void`.
 */
export async function gradeRunSearchOutcomes(
  input: GradeRunSearchOutcomesInput,
): Promise<FlushResult | null> {
  const { runKey, answerText, surface } = input;

  // Both guards are load-bearing, not defensive noise:
  //  - no run key  => we cannot attribute searches, and guessing would
  //                   attribute them to whatever ran most recently;
  //  - empty answer => nothing could have been cited, so every candidate
  //                   would be labelled a negative.
  if (!runKey || answerText.trim().length === 0) return null;

  try {
    const { getApiKey } = await import("../../utils/keyResolver.js");
    if (!(await getApiKey("PAPR_API_KEY"))) return null;

    const [{ getPaprClient }, { paprUserScope }] = await Promise.all([
      import("../../../core/tools/paprClient.js"),
      import("../../utils/paprUserId.js"),
    ]);
    const client = await getPaprClient();

    const result = await flushSearchOutcomeFeedback(
      client as unknown as Parameters<typeof flushSearchOutcomeFeedback>[0],
      answerText,
      paprUserScope(),
      runKey,
    );

    if (result.submitted > 0 || result.skipped > 0) {
      console.log(
        `[searchOutcome:${surface}] submitted=${result.submitted} ` +
          `skipped=${result.skipped} run=${runKey} ` +
          `verdicts=${result.grades.map((g) => g.verdict).join(",")}`,
      );
    }
    return result;
  } catch (error) {
    console.warn(
      `[searchOutcome:${surface}] flush failed for run=${runKey}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
