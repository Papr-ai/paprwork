import { describe, expect, it } from "vitest";
import {
  appendLineageToPublishData,
  trackCollaboratorPublishWarning,
  toPublishLineageSummary,
} from "../src/core/utils/cloudPublishLineageHints.js";
import type { CloudLineageAppEntry } from "../src/gateway/services/CloudAppLineageService.js";

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

  it("warns on track mode only", () => {
    expect(trackCollaboratorPublishWarning(trackShared)).toContain(
      "submit_cloud_app_pr",
    );
    expect(
      trackCollaboratorPublishWarning({ ...trackShared, mode: "fork" }),
    ).toBeNull();
  });

  it("merges lineage and warning into publish tool payload", () => {
    const base = { appId: "local-uuid", enabled: true };
    const merged = appendLineageToPublishData(base, trackShared);
    expect(merged.lineage).toMatchObject({ mode: "track", sourceSlug: "talent-assessment" });
    expect(merged.trackInstallWarning).toContain("apps.papr.ai");
  });
});
