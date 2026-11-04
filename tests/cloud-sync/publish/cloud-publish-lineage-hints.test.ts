import { describe, expect, it } from "vitest";
import {
  appendLineageToPublishData,
  trackCollaboratorPublishWarning,
  toPublishLineageSummary,
} from "../../../src/core/utils/cloudPublishLineageHints.js";
import type { CloudLineageAppEntry } from "../../../src/gateway/services/CloudAppLineageService.js";

const trackShared: CloudLineageAppEntry = {
  appId: "local-uuid",
  mode: "track",
  sourceAppId: "publisher-uuid",
  sourceSlug: "talent-assessment",
  sourceNamespaceId: "ns-1",
  installedAt: "2026-01-01T00:00:00.000Z",
  databasePolicy: "shared",
  sourceAudience: "team",
};

describe("cloudPublishLineageHints", () => {
  it("returns null lineage for apps without papr-cloud-lineage.json", () => {
    expect(toPublishLineageSummary(null)).toBeNull();
    expect(trackCollaboratorPublishWarning(null)).toBeNull();
  });

  it("summarizes track install with source slug", () => {
    expect(toPublishLineageSummary(trackShared)).toEqual({
      mode: "track",
      sourceSlug: "talent-assessment",
      sourceAppId: "publisher-uuid",
      sourceNamespaceId: "ns-1",
      databasePolicy: "shared",
      sourceAudience: "team",
    });
  });

  it("warns only for copies that write the team's shared data", () => {
    expect(trackCollaboratorPublishWarning(trackShared)).toContain(
      "submit_cloud_app_pr",
    );
    expect(
      trackCollaboratorPublishWarning({ ...trackShared, mode: "fork", databasePolicy: "forked" }),
    ).toBeNull();
    // Same routing rule as lineageUsesSharedPrimaryDatabase: shared data is
    // refused whatever mode says.
    expect(
      trackCollaboratorPublishWarning({ ...trackShared, mode: "fork" }),
    ).not.toBeNull();
  });

  it("merges lineage and warning into publish tool payload", () => {
    const base = { appId: "local-uuid", enabled: true };
    const merged = appendLineageToPublishData(base, trackShared);
    expect(merged.lineage).toMatchObject({ mode: "track", sourceSlug: "talent-assessment" });
    expect(merged.trackInstallWarning).toContain("proposal");
  });

  it("v5: a linked copy on its own data publishes like any app (no warning)", () => {
    expect(
      trackCollaboratorPublishWarning({ ...trackShared, databasePolicy: "forked", sourceAudience: "community" }),
    ).toBeNull();
    expect(
      trackCollaboratorPublishWarning({ ...trackShared, databasePolicy: "forked", sourceAudience: "team" }),
    ).toBeNull();
  });

  it("tells the agent a Maintainer/Admin can publishNow instead of waiting for review", () => {
    // Regression: Adam (Admin on the source app) was told his code reaches the
    // team "only through a proposal" because this text never mentioned roles.
    const w = trackCollaboratorPublishWarning(trackShared)!;
    expect(w).toContain("publishNow: true");
    expect(w).toMatch(/Maintainer or Admin/);
    expect(w).toMatch(/Check the role/);
    expect(w).not.toMatch(/only through a proposal/);
  });
});
