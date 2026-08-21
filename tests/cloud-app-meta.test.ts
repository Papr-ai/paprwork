import { describe, expect, it } from "vitest";
import {
  cloudAppMetaRevisionEqual,
  parseCloudAppMetaRevision,
  serializeCloudAppMetaForGit,
  type CloudAppMetaRevision,
} from "../src/gateway/services/cloudSync/cloudAppMeta.js";

describe("cloudAppMeta git serialization", () => {
  const revision: CloudAppMetaRevision = {
    schemaVersion: "1.0.0",
    distRevision: "abc123",
    requiredSchemaVersion: "migration-1",
  };

  it("omits updatedAt from git payload", () => {
    const raw = serializeCloudAppMetaForGit(revision);
    expect(raw).not.toContain("updatedAt");
    expect(JSON.parse(raw)).toEqual(revision);
  });

  it("parses legacy app-meta with updatedAt", () => {
    const legacy = {
      ...revision,
      updatedAt: "2026-08-19T00:00:00.000Z",
    };
    const parsed = parseCloudAppMetaRevision(JSON.stringify(legacy));
    expect(parsed).toEqual(revision);
  });

  it("detects unchanged revision", () => {
    const other: CloudAppMetaRevision = {
      schemaVersion: "1.0.0",
      distRevision: "abc123",
      requiredSchemaVersion: "migration-1",
    };
    expect(cloudAppMetaRevisionEqual(revision, other)).toBe(true);
    expect(
      cloudAppMetaRevisionEqual(revision, {
        ...revision,
        distRevision: "different",
      }),
    ).toBe(false);
  });
});
