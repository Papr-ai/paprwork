import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static invariants for where the misfire policy runs.
 *
 * The reported hang came from ordering, not arithmetic: `reconcileScheduleStates`
 * ran only during core init, which is before anything had read a real
 * `scheduleState` off disk. `data/jobs.json` is a config-only index — its
 * `scheduleState` is null for every job — so that pass computed a fresh future
 * slot for everything and was satisfied, and the stored timestamps arrived
 * afterwards from `job.runtime.json` and from cloud patches, either of which
 * can reinstate a slot from weeks ago.
 *
 * Checked against the source rather than by booting the service because the
 * failure mode *is* the call order, and a reorder is the change most likely to
 * reintroduce it without breaking any behavioural test.
 */
const SERVICE_PATH = path.join(
  process.cwd(),
  "src/gateway/services/JobsService.ts",
);
const source = readFileSync(SERVICE_PATH, "utf8");

function lastIndexOfCall(name: string): number {
  return source.lastIndexOf(`this.${name}()`);
}

function firstIndexOfCall(name: string): number {
  return source.indexOf(`await this.${name}()`);
}

describe("misfire policy ordering in JobsService", () => {
  it("finds the calls it is asserting about", () => {
    // Guard the guard: if these are renamed, the ordering assertions below
    // would pass on -1 === -1 and check nothing at all.
    expect(firstIndexOfCall("reconcileScheduleStates")).toBeGreaterThan(0);
    expect(firstIndexOfCall("migrateAndHydrateJobRuntimeFiles")).toBeGreaterThan(0);
    expect(firstIndexOfCall("hydrateJobRuntimeFromCloud")).toBeGreaterThan(0);
  });

  it("runs the misfire policy again after the local runtime files are merged", () => {
    const hydrateLocal = firstIndexOfCall("migrateAndHydrateJobRuntimeFiles");
    expect(lastIndexOfCall("reconcileScheduleStates")).toBeGreaterThan(
      hydrateLocal,
    );
  });

  it("runs the misfire policy again after cloud runtime patches are applied", () => {
    const hydrateCloud = firstIndexOfCall("hydrateJobRuntimeFromCloud");
    expect(lastIndexOfCall("reconcileScheduleStates")).toBeGreaterThan(
      hydrateCloud,
    );
  });

  it("still reconciles during core init, before the first tick can fire", () => {
    // The post-hydration pass is an addition, not a move: deferred maintenance
    // runs in the background, so without the init pass a job with no stored
    // nextRunAt would have none when the scheduler first looks.
    const initPass = firstIndexOfCall("reconcileScheduleStates");
    const hydrateLocal = firstIndexOfCall("migrateAndHydrateJobRuntimeFiles");
    expect(initPass).toBeLessThan(hydrateLocal);
    expect(lastIndexOfCall("reconcileScheduleStates")).toBeGreaterThan(initPass);
  });

  it("keeps jobs.json config-only, which is why the init pass cannot see nextRunAt", () => {
    // If scheduleState were ever added to the config index, the ordering fix
    // would still be correct but its stated reason would be stale — so pin the
    // premise rather than leaving the comment to rot.
    const fields = readFileSync(
      path.join(process.cwd(), "src/gateway/services/jobs/jobRuntimeFields.ts"),
      "utf8",
    );
    const configBlock = fields.slice(
      fields.indexOf("JOB_CONFIG_FIELD_KEYS"),
      fields.indexOf("JOB_RUNTIME_FIELD_KEYS"),
    );
    expect(configBlock).not.toContain('"scheduleState"');
    expect(fields).toContain('"scheduleState"');
  });
});

describe("scheduler failure path", () => {
  const schedulerSource = readFileSync(
    path.join(process.cwd(), "src/gateway/services/JobsScheduler.ts"),
    "utf8",
  );

  it("advances with the now-aware helper, not the single-step one", () => {
    expect(schedulerSource).toContain("computeNextRunAtAfterSlot");
    // computeFollowingNextRunAt steps exactly once from the anchor, which is
    // the behaviour that could not catch up.
    expect(schedulerSource).not.toContain("computeFollowingNextRunAt");
  });

  // Asserted on the import rather than on any occurrence of the name: a call
  // site renamed to `resolveScheduleFailureOutcomeXX` still *contains* the
  // string, so substring containment cannot tell a wired policy from an
  // unwired one. The policy's behaviour is covered in
  // scheduler-stale-slot-advance.test.ts; this only pins that the scheduler
  // reaches it.
  it("imports the park policy rather than deciding failure handling inline", () => {
    expect(schedulerSource).toMatch(
      /import \{[^}]*\bresolveScheduleFailureOutcome\b[^}]*\}\s*from\s*"\.\/jobs\/schedulePark\.js"/s,
    );
    expect(schedulerSource).toMatch(
      /import \{[^}]*\bclearPermanentFailureStreak\b[^}]*\}\s*from\s*"\.\/jobs\/schedulePark\.js"/s,
    );
    expect(schedulerSource).toMatch(
      /import \{[^}]*\bbuildParkedJobPatch\b[^}]*\}\s*from\s*"\.\/jobs\/schedulePark\.js"/s,
    );
  });

  // The park write must not be reconstructed inline beside the tested helper —
  // a second copy is how the two drift, and the inline one would be untested.
  it("builds the parked record with the helper, not inline", () => {
    expect(schedulerSource).toContain("buildParkedJobPatch(");
    expect(schedulerSource).not.toMatch(/parkedReason:\s*outcome\.reason/);
  });
});
