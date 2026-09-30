import { describe, expect, it } from "vitest";
import type { Artifact } from "../ui/stores/artifactsStore";
import type { AppHealth } from "../src/core/utils/appsHealth";
import {
  duplicateKey,
  findDuplicateGroups,
  inSection,
  isIdLikeTitle,
  sectionCounts,
} from "../ui/utils/appsLibrary";
import { appStatusLine, formatAgo } from "../ui/utils/appStatusLine";
import { toAppsSection } from "../ui/utils/appsViewTabPersistence";

const app = (title: string, over: Partial<Artifact> = {}): Artifact => ({
  id: title,
  title,
  type: "app",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

const health = (over: Partial<AppHealth> = {}): AppHealth => ({
  jobCount: 1,
  scheduleLabel: null,
  scheduledJobCount: 0,
  state: "ok",
  lastRunAt: null,
  nextRunAt: null,
  failingJobName: null,
  error: null,
  failureStreak: 0,
  ...over,
});

describe("duplicate detection", () => {
  it("collapses numbered and (copy) suffixes", () => {
    const k = duplicateKey("Reddit Research Agent");
    expect(duplicateKey("Reddit Research Agent_2")).toBe(k);
    expect(duplicateKey("Reddit Research Agent (copy)")).toBe(k);
    expect(duplicateKey("reddit research agent 3")).toBe(k);
    expect(duplicateKey("Reddit Research Agent copy")).toBe(k);
  });

  it("never groups id-like titles or distinct names", () => {
    expect(duplicateKey("a3f9c1e2-77b0-4c1e-9d2a")).toBeNull();
    expect(duplicateKey("Website Audit")).not.toBe(duplicateKey("SEO Audit"));
  });

  it("groups non-archived copies, most recent first", () => {
    const apps = [
      app("Lead Prospector", { lastOpenedAt: "2026-01-02T00:00:00Z" }),
      app("Lead Prospector_1", { lastOpenedAt: "2026-01-05T00:00:00Z" }),
      app("Lead Prospector_2", { status: "archived" }),
      app("Deck Studio"),
    ];
    const t = (a: Artifact) => Date.parse(a.lastOpenedAt ?? a.updatedAt);
    const groups = findDuplicateGroups(apps, t);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((a) => a.title)).toEqual([
      "Lead Prospector_1",
      "Lead Prospector",
    ]);
  });
});

describe("library sections", () => {
  const ctx = {
    publishedIds: new Set(["Live One"]),
    health: {
      Sched: health({ scheduleLabel: "daily at 9 am", scheduledJobCount: 1 }),
      Broken: health({ state: "failed" }),
    },
  };
  const apps = [
    app("Live One"),
    app("Draft One", { status: "draft" }),
    app("Sched"),
    app("Broken"),
    app("a3f9c1e2-77b0-4c1e-9d2a"),
    app("Old", { status: "archived", favorite: true }),
  ];

  it("counts each section", () => {
    expect(sectionCounts(apps, ctx)).toEqual({
      recent: 5,
      favorites: 0,
      live: 1,
      drafts: 1,
      automations: 1,
      attention: 2,
      archived: 1,
    });
  });

  it("keeps archived apps out of every section but Archived", () => {
    expect(inSection(apps[5], "favorites", ctx)).toBe(false);
    expect(inSection(apps[5], "archived", ctx)).toBe(true);
  });

  it("detects id-like titles", () => {
    expect(isIdLikeTitle("a3f9c1e2-77b0-4c1e")).toBe(true);
    expect(isIdLikeTitle("Deck Studio")).toBe(false);
  });
});

describe("status line", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");

  it("shows a failing schedule with its error and a Fix action", () => {
    const line = appStatusLine(app("X"), {
      isPublished: false,
      now,
      health: health({
        state: "failed",
        scheduleLabel: "every 2 hours",
        lastRunAt: "2026-01-01T11:20:00Z",
        error: "session expired",
      }),
    });
    expect(line).toEqual({
      tone: "fail",
      text: "Every 2 hours · failed 40m ago: session expired",
      action: "Fix",
    });
  });

  it("shows a healthy schedule", () => {
    const line = appStatusLine(app("X"), {
      isPublished: true,
      now,
      health: health({
        scheduleLabel: "daily at 9 am",
        lastRunAt: "2026-01-01T10:00:00Z",
      }),
    });
    expect(line.text).toBe("Daily at 9 am · last run ok 2h ago");
    expect(line.tone).toBe("ok");
  });

  it("falls back to provenance, live, then draft", () => {
    const fork = app("X", {
      cloudLineage: {
        mode: "fork",
        sourceAppId: "s",
        sourceSlug: "Deck Studio",
        sourceNamespaceId: "n",
        installedAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(appStatusLine(fork, { isPublished: false }).text).toBe(
      "Your copy of Deck Studio",
    );
    expect(appStatusLine(app("X"), { isPublished: true }).text).toBe(
      "Live on the web",
    );
    expect(
      appStatusLine(app("X", { status: "draft" }), { isPublished: false }).text,
    ).toBe("Draft · only you can see it");
  });

  it("asks to name id-titled apps and restore archived ones", () => {
    expect(
      appStatusLine(app("a3f9c1e2-77b0-4c1e"), { isPublished: false }).action,
    ).toBe("Name it");
    expect(
      appStatusLine(app("X", { status: "archived" }), { isPublished: false })
        .action,
    ).toBe("Restore");
  });

  it("formats relative times", () => {
    expect(formatAgo("2026-01-01T11:59:40Z", now)).toBe("just now");
    expect(formatAgo("2025-12-29T12:00:00Z", now)).toBe("3d ago");
    expect(formatAgo(undefined, now)).toBe("");
  });
});

describe("section persistence", () => {
  it("maps old tab ids onto sidebar sections", () => {
    expect(toAppsSection("my-apps")).toBe("recent");
    expect(toAppsSection("namespace-community")).toBe("team");
    expect(toAppsSection("community")).toBe("community");
    expect(toAppsSection("automations")).toBe("automations");
    expect(toAppsSection("nonsense")).toBeNull();
  });
});
