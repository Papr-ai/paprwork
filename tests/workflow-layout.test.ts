import { describe, expect, it } from "vitest";
import { computeWorkflowLayout } from "../ui/components/Jobs/workflowUtils";
import {
  jobTriggerKind,
  jobTriggerLabel,
  scheduleSortMinutes,
  scheduleTimeLabel,
} from "../ui/utils/jobTriggerLabel";
import type { JobRecord } from "../ui/hooks/useJobs";

function makeJob(
  partial: Partial<JobRecord> & Pick<JobRecord, "id" | "name">,
): JobRecord {
  return {
    type: "python",
    status: "pending",
    appIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("jobTriggerKind", () => {
  it("classifies scheduled entry jobs", () => {
    const job = makeJob({
      id: "a",
      name: "Morning",
      schedule: { enabled: true, cron: "0 7 * * *" },
    });
    expect(jobTriggerKind(job)).toBe("scheduled");
  });

  it("classifies dependency jobs", () => {
    const job = makeJob({
      id: "b",
      name: "Follow-up",
      dependsOn: [{ jobId: "a", onStatus: "completed" }],
    });
    expect(jobTriggerKind(job)).toBe("dependency");
  });

  it("classifies manual jobs", () => {
    const job = makeJob({ id: "c", name: "On demand" });
    expect(jobTriggerKind(job)).toBe("manual");
  });
});

describe("jobTriggerLabel", () => {
  it("returns Manual for on-demand jobs", () => {
    const job = makeJob({ id: "c", name: "On demand" });
    expect(jobTriggerLabel(job, [])).toBe("Manual");
  });
});

describe("scheduleSortMinutes", () => {
  it("orders cron jobs by time of day", () => {
    const early = makeJob({
      id: "a",
      name: "Early",
      schedule: { enabled: true, cron: "5 2 * * *" },
    });
    const late = makeJob({
      id: "b",
      name: "Late",
      schedule: { enabled: true, cron: "0 10 * * *" },
    });
    expect(scheduleSortMinutes(early)).toBeLessThan(scheduleSortMinutes(late));
  });

  it("extracts a short time label from cron", () => {
    const job = makeJob({
      id: "a",
      name: "Morning",
      schedule: { enabled: true, cron: "0 7 * * *" },
    });
    expect(scheduleTimeLabel(job)).toBe("7 AM");
  });
});

describe("computeWorkflowLayout", () => {
  it("sorts scheduled jobs by time within the same column", () => {
    const jobs = [
      makeJob({
        id: "late",
        name: "Late",
        schedule: { enabled: true, cron: "0 10 * * *" },
      }),
      makeJob({
        id: "early",
        name: "Early",
        schedule: { enabled: true, cron: "5 2 * * *" },
      }),
    ];

    const layout = computeWorkflowLayout(jobs, []);
    const early = layout.positions.find((p) => p.id === "early");
    const late = layout.positions.find((p) => p.id === "late");

    expect(early?.x).toBe(late?.x);
    expect((early?.y ?? 0)).toBeLessThan(late?.y ?? 0);
  });

  it("places dependency jobs to the right of their parents", () => {
    const jobs = [
      makeJob({
        id: "root",
        name: "Root",
        schedule: { enabled: true, cron: "0 7 * * *" },
      }),
      makeJob({
        id: "child",
        name: "Child",
        dependsOn: [{ jobId: "root", onStatus: "completed" }],
      }),
    ];
    const edges = [
      { from: "root", to: "child", onStatus: "completed" as const },
    ];

    const layout = computeWorkflowLayout(jobs, edges);
    const root = layout.positions.find((p) => p.id === "root");
    const child = layout.positions.find((p) => p.id === "child");

    expect((root?.x ?? 0)).toBeLessThan(child?.x ?? 0);
    expect(child?.triggerKind).toBe("dependency");
  });

  it("keeps manual jobs in the main flow with other entry jobs", () => {
    const jobs = [
      makeJob({
        id: "scheduled",
        name: "Scheduled",
        schedule: { enabled: true, cron: "0 7 * * *" },
      }),
      makeJob({ id: "manual", name: "Manual run" }),
    ];

    const layout = computeWorkflowLayout(jobs, []);
    const scheduled = layout.positions.find((p) => p.id === "scheduled");
    const manual = layout.positions.find((p) => p.id === "manual");

    expect(scheduled?.x).toBe(manual?.x);
    expect((scheduled?.y ?? 0)).toBeLessThan(manual?.y ?? 0);
    expect(manual?.triggerKind).toBe("manual");
  });
});
