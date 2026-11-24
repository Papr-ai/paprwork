import { describe, expect, it } from "vitest";
import {
  WIDE_CARD,
  groupJobSections,
  layoutSection,
} from "../../ui/components/Jobs/jobSections";
import type { JobGraph, JobRecord } from "../../ui/hooks/useJobs";

function job(partial: Partial<JobRecord> & Pick<JobRecord, "id" | "name">): JobRecord {
  return {
    type: "python",
    status: "completed",
    appIds: ["app"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const daily = (cron: string) => ({ enabled: true, cron });

/** The LinkedIn Outreach app from the prototype. */
const JOBS: JobRecord[] = [
  job({ id: "cs", name: "Connection Sender", schedule: daily("5 9 * * *") }),
  job({ id: "gh", name: "Graph Harvester", schedule: daily("0 10 * * *") }),
  job({ id: "wa", name: "Weekly Analyst", type: "agent", schedule: daily("30 10 * * 1") }),
  job({ id: "rd", name: "Reply Detector", dependsOn: [{ jobId: "gh", onStatus: "completed" }] }),
  job({ id: "ms", name: "Message Sender", dependsOn: [{ jobId: "rd", onStatus: "completed" }] }),
  job({ id: "ss", name: "Search Scraper", status: "failed" }),
  job({ id: "dr", name: "Reply Drafter", type: "agent" }),
  job({ id: "rs", name: "Reply Sender" }),
  job({ id: "bf", name: "Backfill history" }),
];

const EDGES: JobGraph["edges"] = [
  { from: "gh", to: "rd", onStatus: "completed" },
  { from: "rd", to: "ms", onStatus: "completed" },
];

describe("groupJobSections", () => {
  const sections = groupJobSections(JOBS, EDGES);
  const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

  it("orders sections Scheduled, One off", () => {
    expect(sections.map((s) => s.id)).toEqual(["scheduled", "oneOff"]);
  });

  it("keeps a scheduled chain together, ordered by start time", () => {
    expect(byId.scheduled.jobs.map((j) => j.id)).toEqual(["cs", "gh", "rd", "ms", "wa"]);
    expect(byId.scheduled.edges).toHaveLength(2);
  });

  it("puts everything else, including jobs the app runs, under One off", () => {
    expect(byId.oneOff.jobs.map((j) => j.id).sort()).toEqual(["bf", "dr", "rs", "ss"]);
  });

  it("never shows a job twice", () => {
    const s = groupJobSections(JOBS, EDGES);
    const all = s.flatMap((x) => x.jobs.map((j) => j.id));
    expect(new Set(all).size).toBe(all.length);
    expect(s.find((x) => x.id === "scheduled")?.jobs.map((j) => j.id)).toContain("rd");
  });

  it("labels fail and runtime edges", () => {
    const s = groupJobSections(
      [
        job({ id: "a", name: "A", schedule: daily("0 * * * *") }),
        job({ id: "b", name: "B", dependsOn: [{ jobId: "a", onStatus: "failed" }] }),
        job({ id: "c", name: "C" }),
      ],
      [
        { from: "a", to: "b", onStatus: "failed" },
        { from: "a", to: "c", onStatus: "completed", isRuntimeCall: true },
      ]);
    expect(s).toHaveLength(1);
    expect(s[0].edges.map((e) => e.kind).sort()).toEqual(["failed", "runtime"]);
  });

  it("returns nothing for an app with no jobs", () => {
    expect(groupJobSections([], [])).toEqual([]);
  });
});

describe("layoutSection", () => {
  it("puts each step of a chain in the next column", () => {
    const [scheduled] = groupJobSections(JOBS, EDGES);
    const { positions } = layoutSection(scheduled, WIDE_CARD);
    const col = (id: string) => (positions.get(id)!.x - WIDE_CARD.pad - 6) / (WIDE_CARD.w + WIDE_CARD.col);
    expect([col("gh"), col("rd"), col("ms")]).toEqual([0, 1, 2]);
    expect(col("cs")).toBe(0);
  });

  it("wraps unconnected jobs into rows", () => {
    const section = groupJobSections(JOBS, EDGES).find((s) => s.id === "oneOff")!;
    const { positions, height } = layoutSection(section, WIDE_CARD, 2);
    const ys = new Set([...positions.values()].map((p) => p.y));
    expect(ys.size).toBe(2);
    expect(height).toBe(WIDE_CARD.pad + 2 * WIDE_CARD.h + WIDE_CARD.row + WIDE_CARD.pad);
  });

  it("survives a dependency cycle", () => {
    const s = groupJobSections(
      [
        job({ id: "x", name: "X", dependsOn: [{ jobId: "y", onStatus: "completed" }] }),
        job({ id: "y", name: "Y", dependsOn: [{ jobId: "x", onStatus: "completed" }] }),
      ],
      []);
    expect(() => layoutSection(s[0], WIDE_CARD)).not.toThrow();
  });
});
