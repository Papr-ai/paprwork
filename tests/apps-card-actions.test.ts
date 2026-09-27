import { describe, expect, it } from "vitest";
import { buildFixAppMessage } from "../ui/utils/openAppToFix";
import { shareGlyphForPrefs } from "../ui/utils/shareGlyph";
import type { AppHealth } from "../src/core/utils/appsHealth";

const failing: AppHealth = {
  jobCount: 2,
  scheduleLabel: "daily at 9 am",
  scheduledJobCount: 1,
  state: "failed",
  lastRunAt: "2026-09-26T09:00:00Z",
  nextRunAt: null,
  failingJobName: "Sync inbox",
  failingJobId: "job-123",
  error: "Session expired",
  failureStreak: 3,
};

describe("Fix message sent to Pen", () => {
  it("names the app, job, error and streak so Pen can start without asking", () => {
    const msg = buildFixAppMessage({ appId: "app-1", appTitle: "Inbox", health: failing });
    expect(msg).toContain('"Inbox" (appId: app-1)');
    expect(msg).toContain("Sync inbox (jobId: job-123)");
    expect(msg).toContain("Last error: Session expired");
    expect(msg).toContain("3 times in a row");
    expect(msg).toMatch(/re-run the job/);
  });

  it("still asks for a fix when health details are missing", () => {
    const msg = buildFixAppMessage({ appId: "a", appTitle: "X" });
    expect(msg).toContain("failing automation");
    expect(msg).not.toContain("undefined");
  });
});

describe("share icon from local sharing prefs", () => {
  it("maps prefs to the share-bar audience", () => {
    expect(shareGlyphForPrefs({ loginAccess: "private", externalLink: "off" })).toEqual({
      audience: "private",
      codeAccess: "off",
    });
    expect(shareGlyphForPrefs({ loginAccess: "team", externalLink: "off" }).audience).toBe("team");
    expect(
      shareGlyphForPrefs({ loginAccess: "public", externalLink: "off", codeAccess: "install" }),
    ).toEqual({ audience: "public", codeAccess: "install" });
    expect(shareGlyphForPrefs({ loginAccess: "none", externalLink: "read" }).audience).toBe("link");
  });

  it("shows specific-people sharing, not plain team", () => {
    expect(
      shareGlyphForPrefs({
        loginAccess: "team",
        externalLink: "off",
        allowedEmails: ["a@b.co"],
      }).audience,
    ).not.toBe("team");
  });
});
