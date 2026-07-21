import { describe, expect, it } from "vitest";
import {
  parseCloudAppLineageFile,
  serializeCloudAppLineageFile,
} from "../src/core/utils/cloudAppLineage.js";

describe("cloudAppLineage", () => {
  it("round-trips lineage file", () => {
    const lineage = {
      schemaVersion: "1.0.0" as const,
      lineageId: "lineage-1",
      mode: "fork" as const,
      source: {
        orgId: "org-1",
        namespaceId: "ns-1",
        userId: "user-1",
        appId: "app-source",
        slug: "my-app",
      },
      installedAt: "2026-06-30T00:00:00.000Z",
    };

    const raw = serializeCloudAppLineageFile(lineage);
    const parsed = parseCloudAppLineageFile(raw);
    expect(parsed).toEqual(lineage);
  });

  it("rejects invalid lineage json", () => {
    expect(parseCloudAppLineageFile("{}")).toBeNull();
    expect(parseCloudAppLineageFile("not json")).toBeNull();
  });
});
