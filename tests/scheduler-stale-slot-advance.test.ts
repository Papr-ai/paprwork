import { describe, expect, it } from "vitest";
import {
  computeFollowingNextRunAt,
  computeNextRunAtAfterSlot,
} from "../src/gateway/services/jobs/scheduleEngine.js";
import { classifyError } from "../src/gateway/services/jobs/errorClassifier.js";
import {
  MAX_CONSECUTIVE_PERMANENT_FAILURES,
  buildParkedJobPatch,
  clearPermanentFailureStreak,
  isPermanentJobRunFailure,
  resolveScheduleFailureOutcome,
} from "../src/gateway/services/jobs/schedulePark.js";
import type {
  JobRecord,
  JobSchedule,
} from "../src/gateway/services/jobs/types.js";

/**
 * The reported failure verbatim: a cron job whose nextRunAt sat eight days in
 * the past, relaunching on every tick because each failure advanced it by a
 * single 30-minute slot that was also in the past.
 */
const STALE_DUE_AT = new Date("2026-09-06T19:30:00.000Z");
const NOW = new Date("2026-09-14T22:13:49.000Z");

const cronEvery30: JobSchedule = { enabled: true, cron: "*/30 * * * *" };

describe("computeNextRunAtAfterSlot — cron", () => {
  it("lands in the future from an eight-day-stale anchor", () => {
    const next = computeNextRunAtAfterSlot(cronEvery30, STALE_DUE_AT, NOW);
    expect(next).toBeDefined();
    expect(new Date(next as string).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("pins the old single-step behaviour as the actual defect", () => {
    // Kept as a contrast rather than as a target: this is what the scheduler
    // used to write back after a failed run. It is a full week behind `now`,
    // so the job is due again immediately and relaunches on the next tick.
    const single = computeFollowingNextRunAt(cronEvery30, STALE_DUE_AT);
    expect(new Date(single as string).getTime()).toBeLessThan(NOW.getTime());
  });

  it("stays on the cron grid when it catches up", () => {
    const next = new Date(
      computeNextRunAtAfterSlot(cronEvery30, STALE_DUE_AT, NOW) as string,
    );
    // */30 fires on the hour and the half hour; nothing in between.
    expect([0, 30]).toContain(next.getUTCMinutes());
    expect(next.getUTCSeconds()).toBe(0);
  });

  it("takes the single step when the anchor is current", () => {
    const anchor = new Date("2026-09-14T22:00:00.000Z");
    const now = new Date("2026-09-14T22:00:03.000Z");
    expect(computeNextRunAtAfterSlot(cronEvery30, anchor, now)).toBe(
      computeFollowingNextRunAt(cronEvery30, anchor),
    );
  });

  it("reaches a future slot in one call however stale the anchor is", () => {
    const ancient = new Date("2024-01-01T00:00:00.000Z");
    const next = computeNextRunAtAfterSlot(cronEvery30, ancient, NOW);
    expect(new Date(next as string).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("computeNextRunAtAfterSlot — interval", () => {
  const tenMinutes: JobSchedule = { enabled: true, intervalMs: 600_000 };

  it("preserves phase while catching up, so intervals do not drift", () => {
    // Anchored at :00 on a 10-minute interval, a catch-up must land on a
    // 10-minute boundary measured from the anchor — not at `now` plus ten
    // minutes, which is what a naive misfire-skip would produce and is the
    // drift an earlier fix removed on purpose.
    const anchor = new Date("2026-09-14T12:00:00.000Z");
    const now = new Date("2026-09-14T14:07:00.000Z");
    const next = new Date(
      computeNextRunAtAfterSlot(tenMinutes, anchor, now) as string,
    );
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect((next.getTime() - anchor.getTime()) % 600_000).toBe(0);
    expect(next.toISOString()).toBe("2026-09-14T14:10:00.000Z");
  });

  it("takes exactly one step in the healthy case", () => {
    const anchor = new Date("2026-09-14T12:00:00.000Z");
    const now = new Date("2026-09-14T12:00:02.000Z");
    expect(computeNextRunAtAfterSlot(tenMinutes, anchor, now)).toBe(
      "2026-09-14T12:10:00.000Z",
    );
  });

  it("takes one step when the anchor is ahead of now (clock skew)", () => {
    const anchor = new Date("2026-09-14T12:00:00.000Z");
    const now = new Date("2026-09-14T11:58:00.000Z");
    expect(computeNextRunAtAfterSlot(tenMinutes, anchor, now)).toBe(
      "2026-09-14T12:10:00.000Z",
    );
  });

  it("lands strictly after now when now sits exactly on a boundary", () => {
    const anchor = new Date("2026-09-14T12:00:00.000Z");
    const now = new Date("2026-09-14T12:20:00.000Z");
    const next = computeNextRunAtAfterSlot(tenMinutes, anchor, now);
    expect(next).toBe("2026-09-14T12:30:00.000Z");
    expect(new Date(next as string).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("computeNextRunAtAfterSlot — schedules with nothing to advance", () => {
  it("returns nothing for a disabled schedule", () => {
    expect(
      computeNextRunAtAfterSlot(
        { ...cronEvery30, enabled: false },
        STALE_DUE_AT,
        NOW,
      ),
    ).toBeUndefined();
  });

  it("returns nothing for a one-shot atTime schedule", () => {
    expect(
      computeNextRunAtAfterSlot(
        { enabled: true, atTime: "2026-09-06T19:30:00.000Z" },
        STALE_DUE_AT,
        NOW,
      ),
    ).toBeUndefined();
  });

  it("returns nothing for an unparseable cron rather than guessing", () => {
    expect(
      computeNextRunAtAfterSlot(
        { enabled: true, cron: "not a cron" },
        STALE_DUE_AT,
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("isPermanentJobRunFailure", () => {
  const validationFailure = new Error(
    "Job architecture validation failed before run:\n" +
      "[job-write-dbids-invalid] writeDbIds references unknown or tombstoned " +
      "database: db-15c6b141. Create it with create_database first.",
  );

  it("treats pre-run validation as permanent by construction", () => {
    // The run never started, so its inputs are unchanged and the identical
    // inputs produce the identical refusal.
    expect(isPermanentJobRunFailure(validationFailure)).toBe(true);
  });

  it("does not delegate that judgement to classifyError, which gets it wrong", async () => {
    // Documents why the explicit check above exists: classifyError looks for
    // "validation error" and this message says "validation failed", so it
    // falls through to its transient default. If that ever changes this
    // assertion should be updated, not deleted — the point is that the
    // scheduler must not depend on the string match either way.
    const { classifyError } = await import(
      "../src/gateway/services/jobs/errorClassifier.js"
    );
    expect(classifyError(validationFailure)).toBe("transient");
  });

  it("leaves genuinely transient failures alone", () => {
    expect(isPermanentJobRunFailure(new Error("ECONNRESET"))).toBe(false);
    expect(isPermanentJobRunFailure(new Error("request timed out"))).toBe(false);
    expect(isPermanentJobRunFailure(new Error("429 rate limit"))).toBe(false);
  });

  it("still recognises the classifier's own permanent cases", () => {
    expect(isPermanentJobRunFailure(new Error("401 unauthorized"))).toBe(true);
    expect(isPermanentJobRunFailure(new Error("invalid api key"))).toBe(true);
  });

  it("does not throw on a non-Error rejection", () => {
    expect(isPermanentJobRunFailure("some string")).toBe(false);
    expect(isPermanentJobRunFailure(undefined)).toBe(false);
  });
});

describe("resolveScheduleFailureOutcome", () => {
  const permanent = new Error("Job architecture validation failed before run:\nbad db");

  it("advances rather than parking on the first permanent failure", () => {
    const outcome = resolveScheduleFailureOutcome({}, permanent);
    expect(outcome.kind).toBe("advance");
    expect(outcome.consecutivePermanentFailures).toBe(1);
  });

  it("parks once the streak reaches the threshold", () => {
    const outcome = resolveScheduleFailureOutcome(
      { consecutivePermanentFailures: MAX_CONSECUTIVE_PERMANENT_FAILURES - 1 },
      permanent,
    );
    expect(outcome.kind).toBe("park");
    if (outcome.kind === "park") {
      expect(outcome.reason).toContain("Re-enable the schedule");
      // The user has to be told what actually failed, not just that it did.
      expect(outcome.reason).toContain("bad db");
    }
  });

  it("holds the streak steady through a transient failure", () => {
    // A dropped connection is evidence about the network, not about whether
    // the job is configured correctly — so it neither confirms a
    // misconfiguration nor clears one.
    const outcome = resolveScheduleFailureOutcome(
      { consecutivePermanentFailures: 2 },
      new Error("ECONNRESET"),
    );
    expect(outcome.kind).toBe("advance");
    expect(outcome.consecutivePermanentFailures).toBe(2);
  });

  it("never parks on transient failures however many there are", () => {
    const outcome = resolveScheduleFailureOutcome(
      { consecutivePermanentFailures: 0 },
      new Error("connection reset"),
    );
    expect(outcome.kind).toBe("advance");
  });

  it("treats absent schedule state as a clean slate", () => {
    const outcome = resolveScheduleFailureOutcome(undefined, permanent);
    expect(outcome.consecutivePermanentFailures).toBe(1);
  });
});

describe("isPermanentJobRunFailure covers the unusable-database storm", () => {
  // Found by mutation-testing the park policy against the pre-existing
  // job-unusable-database-retry-storm suite: a corrupt linked file surfaces as
  // a raw SqliteError, which classifyError has no rule for and therefore calls
  // transient. Without these the job that suite was written about would never
  // reach the park threshold and would fail at its interval rate forever —
  // quieter than the tick-rate storm, but just as endless.
  it("treats a raw SQLITE_NOTADB error as permanent", () => {
    const error = Object.assign(new Error("file is not a database"), {
      code: "SQLITE_NOTADB",
    });
    expect(isPermanentJobRunFailure(error)).toBe(true);
    expect(classifyError(error)).toBe("transient"); // pins why the rule is needed
  });

  it("treats malformed image and schema errors as permanent", () => {
    expect(
      isPermanentJobRunFailure(new Error("database disk image is malformed")),
    ).toBe(true);
    expect(
      isPermanentJobRunFailure(
        new Error("malformed database schema (_papr_tr_investors_au)"),
      ),
    ).toBe(true);
  });

  it("matches architecture validation failures in either wording", () => {
    // The reported failure says "failed before run:"; the older retry-storm
    // suite uses "failed: table missing". Both are the same refusal.
    expect(
      isPermanentJobRunFailure(
        new Error("Job architecture validation failed before run:\n[x] bad"),
      ),
    ).toBe(true);
    expect(
      isPermanentJobRunFailure(
        new Error("Job architecture validation failed: table missing"),
      ),
    ).toBe(true);
  });

  it("still calls a locked or dropped database transient", () => {
    // These must keep retrying — the file is fine, something else holds it.
    // "database is locked" sits one word from the malformed patterns above.
    expect(isPermanentJobRunFailure(new Error("database is locked"))).toBe(
      false,
    );
    expect(isPermanentJobRunFailure(new Error("fetch failed"))).toBe(false);
    expect(isPermanentJobRunFailure(new Error("ECONNRESET"))).toBe(false);
  });

  it("parks a repeating unusable database", () => {
    const error = Object.assign(new Error("file is not a database"), {
      code: "SQLITE_NOTADB",
    });
    const outcome = resolveScheduleFailureOutcome(
      { consecutivePermanentFailures: MAX_CONSECUTIVE_PERMANENT_FAILURES - 1 },
      error,
    );
    expect(outcome.kind).toBe("park");
  });
});

describe("buildParkedJobPatch", () => {
  const parkOutcome = {
    kind: "park" as const,
    consecutivePermanentFailures: MAX_CONSECUTIVE_PERMANENT_FAILURES,
    reason: "Scheduling paused after 3 runs. Last error: db-15c6b141 missing",
  };

  function jobFixture(): JobRecord & { schedule: JobSchedule } {
    return {
      id: "aa70ed04-4efb-4c1e-bc5b-6e4bffa49964",
      name: "LinkedIn sync",
      type: "python",
      command: "python3 code/main.py",
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-09-06T19:30:00.000Z",
      schedule: { enabled: true, cron: "*/30 * * * *" },
      scheduleState: {
        nextRunAt: "2026-09-06T19:30:00.000Z",
        consecutivePermanentFailures: 2,
      },
    } as unknown as JobRecord & { schedule: JobSchedule };
  }

  it("switches the schedule off", () => {
    const patch = buildParkedJobPatch(
      jobFixture(),
      parkOutcome,
      "2026-09-14T22:14:00.000Z",
      "2026-09-14T22:14:00.000Z",
    );
    expect(patch.schedule?.enabled).toBe(false);
    // The cron expression survives, so re-enabling restores the user's
    // schedule rather than requiring them to retype it.
    expect(patch.schedule?.cron).toBe("*/30 * * * *");
  });

  it("clears nextRunAt so re-enabling does not fire instantly", () => {
    // A due timestamp left behind on a disabled schedule makes the job launch
    // on the very next tick after someone re-enables it — the loop this whole
    // change exists to end, re-armed.
    const patch = buildParkedJobPatch(
      jobFixture(),
      parkOutcome,
      "2026-09-14T22:14:00.000Z",
      "2026-09-14T22:14:00.000Z",
    );
    expect(patch.scheduleState?.nextRunAt).toBeUndefined();
  });

  it("records why it stopped, on the record and as the job error", () => {
    const patch = buildParkedJobPatch(
      jobFixture(),
      parkOutcome,
      "2026-09-14T22:14:00.000Z",
      "2026-09-14T22:15:00.000Z",
    );
    expect(patch.scheduleState?.parkedReason).toBe(parkOutcome.reason);
    expect(patch.scheduleState?.parkedAt).toBe("2026-09-14T22:15:00.000Z");
    expect(patch.error).toBe(parkOutcome.reason);
    expect(patch.updatedAt).toBe("2026-09-14T22:15:00.000Z");
    expect(patch.scheduleState?.lastTriggeredAt).toBe(
      "2026-09-14T22:14:00.000Z",
    );
    expect(patch.scheduleState?.consecutivePermanentFailures).toBe(
      MAX_CONSECUTIVE_PERMANENT_FAILURES,
    );
  });

  it("leaves everything else on the job alone", () => {
    const job = jobFixture();
    const patch = buildParkedJobPatch(
      job,
      parkOutcome,
      "2026-09-14T22:14:00.000Z",
      "2026-09-14T22:14:00.000Z",
    );
    expect(patch.id).toBe(job.id);
    expect(patch.command).toBe(job.command);
    expect(patch.type).toBe(job.type);
    // Not mutated in place — the caller may still need the original.
    expect(job.schedule.enabled).toBe(true);
    expect(job.scheduleState?.nextRunAt).toBe("2026-09-06T19:30:00.000Z");
  });
});

describe("clearPermanentFailureStreak", () => {
  it("returns explicit undefineds so a merge actually clears the streak", () => {
    // An object with the keys deleted would leave the old values in place
    // when spread over the carried-forward state, which is the opposite of
    // clearing them.
    const patch = clearPermanentFailureStreak();
    expect("consecutivePermanentFailures" in patch).toBe(true);
    expect(patch.consecutivePermanentFailures).toBeUndefined();

    const merged = {
      ...{ consecutivePermanentFailures: 2, parkedReason: "x", parkedAt: "y" },
      ...patch,
    };
    expect(merged.consecutivePermanentFailures).toBeUndefined();
    expect(merged.parkedReason).toBeUndefined();
    expect(merged.parkedAt).toBeUndefined();
  });
});
