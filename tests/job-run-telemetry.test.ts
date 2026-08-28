import { describe, expect, it } from "vitest";
import {
  buildJobRunDimensions,
  isAgentJobType,
} from "../src/core/telemetry/jobRunTelemetry.js";

describe("isAgentJobType", () => {
  it("treats agent and subagent as agent work", () => {
    expect(isAgentJobType("agent")).toBe(true);
    expect(isAgentJobType("subagent")).toBe(true);
  });

  it("treats scripted runtimes as script work", () => {
    for (const type of ["python", "node", "bash", "shell", "swift"]) {
      expect(isAgentJobType(type)).toBe(false);
    }
  });
});

describe("buildJobRunDimensions", () => {
  it("attributes a run to its owning mini-app", () => {
    const d = buildJobRunDimensions({
      jobId: "job-1",
      jobType: "agent",
      appIds: ["app-books"],
      durationMs: 60_000,
      surface: "local",
    });

    expect(d.app_id).toBe("app-books");
    expect(d.app_count).toBe(1);
    expect(d.is_standalone).toBe(false);
  });

  it("does not report the standalone sentinel as an app", () => {
    const d = buildJobRunDimensions({
      jobId: "job-1",
      jobType: "python",
      appIds: ["__standalone__"],
      durationMs: 1_000,
      surface: "local",
    });

    // A standalone job counting as app "__standalone__" would invent a
    // phantom app in every per-app breakdown.
    expect(d.app_id).toBeUndefined();
    expect(d.app_count).toBe(0);
    expect(d.is_standalone).toBe(true);
  });

  it("counts multi-app jobs while attributing to the first app", () => {
    const d = buildJobRunDimensions({
      jobId: "job-1",
      jobType: "python",
      appIds: ["app-a", "app-b", "app-c"],
      durationMs: 1_000,
      surface: "local",
    });

    expect(d.app_id).toBe("app-a");
    expect(d.app_count).toBe(3);
  });

  it("converts duration to hours so charts can sum directly", () => {
    const oneHour = buildJobRunDimensions({
      jobId: "j",
      jobType: "agent",
      durationMs: 3_600_000,
      surface: "local",
    });
    expect(oneHour.duration_hours).toBe(1);

    const halfHour = buildJobRunDimensions({
      jobId: "j",
      jobType: "agent",
      durationMs: 1_800_000,
      surface: "local",
    });
    expect(halfHour.duration_hours).toBe(0.5);
  });

  it("clamps negative or non-finite durations to zero", () => {
    // performance.now() deltas can go negative across clock adjustments;
    // a negative hour would silently subtract from workspace totals.
    for (const bad of [-5_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = buildJobRunDimensions({
        jobId: "j",
        jobType: "agent",
        durationMs: bad,
        surface: "local",
      });
      expect(d.duration_ms).toBe(0);
      expect(d.duration_hours).toBe(0);
    }
  });

  it("separates agent work from script work", () => {
    const agent = buildJobRunDimensions({
      jobId: "j",
      jobType: "subagent",
      durationMs: 1_000,
      surface: "local",
      subAgentId: "accounting-agent",
    });
    expect(agent.agent_kind).toBe("agent");
    expect(agent.is_agent).toBe(true);
    expect(agent.has_custom_agent).toBe(true);

    const script = buildJobRunDimensions({
      jobId: "j",
      jobType: "python",
      durationMs: 1_000,
      surface: "local",
    });
    expect(script.agent_kind).toBe("script");
    expect(script.is_agent).toBe(false);
    expect(script.has_custom_agent).toBe(false);
  });

  it("never marks a script job as having a custom agent", () => {
    const d = buildJobRunDimensions({
      jobId: "j",
      jobType: "python",
      durationMs: 1_000,
      surface: "local",
      subAgentId: "leftover-id",
    });
    expect(d.has_custom_agent).toBe(false);
  });

  it("keeps local and cloud runs in the same shape", () => {
    const keys = (surface: "local" | "cloud") =>
      Object.keys(
        buildJobRunDimensions({
          jobId: "j",
          jobType: "agent",
          appIds: ["app-a"],
          durationMs: 1_000,
          surface,
        }),
      ).sort();

    // Divergent shapes would make sum(duration_hours) mean different things
    // depending on where the job happened to run.
    expect(keys("local")).toEqual(keys("cloud"));
  });

  it("defaults trigger from the scheduled flag when not given", () => {
    expect(
      buildJobRunDimensions({
        jobId: "j",
        jobType: "python",
        durationMs: 1,
        surface: "local",
        scheduled: true,
      }).trigger,
    ).toBe("scheduled");

    expect(
      buildJobRunDimensions({
        jobId: "j",
        jobType: "python",
        durationMs: 1,
        surface: "local",
      }).trigger,
    ).toBe("manual");
  });

  it("prefers an explicit trigger over the scheduled flag", () => {
    expect(
      buildJobRunDimensions({
        jobId: "j",
        jobType: "python",
        durationMs: 1,
        surface: "local",
        scheduled: true,
        trigger: "dependency",
      }).trigger,
    ).toBe("dependency");
  });

  it("sums agent hours per app across mixed runs", () => {
    // Mirrors the reporting question: for one mini-app, how many hours did
    // agents work, ignoring script jobs in the same app?
    const runs = [
      { jobType: "subagent", durationMs: 3_600_000 },
      { jobType: "agent", durationMs: 1_800_000 },
      { jobType: "python", durationMs: 7_200_000 },
    ].map((r) =>
      buildJobRunDimensions({
        jobId: "j",
        jobType: r.jobType,
        appIds: ["app-books"],
        durationMs: r.durationMs,
        surface: "local",
      }),
    );

    const agentHours = runs
      .filter((r) => r.is_agent && r.app_id === "app-books")
      .reduce((sum, r) => sum + r.duration_hours, 0);

    expect(agentHours).toBe(1.5);
    expect(runs.length).toBe(3);
  });
});
