import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveJobWriteTargets = vi.fn();

vi.mock("../src/gateway/services/jobAppDatabase.js", () => ({
  resolveJobWriteTargets: (...args: unknown[]) => resolveJobWriteTargets(...args),
}));

import {
  resolveJobTursoSyncKeys,
  resolveJobTursoSyncKeysAsync,
} from "../src/gateway/services/jobTursoSyncBookends.js";

describe("resolveJobTursoSyncKeys", () => {
  it("uses writeDbIds when present", () => {
    expect(
      resolveJobTursoSyncKeys({
        id: "51abf434-1d0f-4f14-8111-fabe8eedf224",
        writeDbIds: ["db-2d6b4294"],
      }),
    ).toEqual(["db-2d6b4294"]);
  });

  it("falls back to job id for scratch-only jobs", () => {
    expect(
      resolveJobTursoSyncKeys({
        id: "job-scratch-1",
        writeDbIds: [],
      }),
    ).toEqual(["job-scratch-1"]);
  });

  it("deduplicates multiple writeDbIds", () => {
    expect(
      resolveJobTursoSyncKeys({
        id: "job-1",
        writeDbIds: ["db-a", "db-a", " db-b "],
      }),
    ).toEqual(["db-a", "db-b"]);
  });
});

describe("resolveJobTursoSyncKeysAsync", () => {
  beforeEach(() => {
    resolveJobWriteTargets.mockReset();
  });

  it("uses writeDbIds when present without registry lookup", async () => {
    await expect(
      resolveJobTursoSyncKeysAsync({
        id: "job-1",
        writeDbIds: ["db-registry-1"],
        appIds: ["app-1"],
      }),
    ).resolves.toEqual(["db-registry-1"]);
    expect(resolveJobWriteTargets).not.toHaveBeenCalled();
  });

  it("includes legacy primary registry dbId when writeDbIds is empty", async () => {
    resolveJobWriteTargets.mockResolvedValue([
      {
        dbId: "db-legacy-primary",
        alias: "primary",
        dbPath: "/tmp/data.db",
        envKey: "APP_DB",
      },
    ]);

    await expect(
      resolveJobTursoSyncKeysAsync({
        id: "job-legacy",
        writeDbIds: [],
        appIds: ["app-dashboard"],
      }),
    ).resolves.toEqual(["db-legacy-primary"]);
  });

  it("falls back to job id when no writeDbIds and no registry targets", async () => {
    resolveJobWriteTargets.mockResolvedValue([]);

    await expect(
      resolveJobTursoSyncKeysAsync({
        id: "job-scratch",
        writeDbIds: [],
        appIds: [],
      }),
    ).resolves.toEqual(["job-scratch"]);
  });

  it("falls back to job id when registry lookup throws", async () => {
    resolveJobWriteTargets.mockRejectedValue(new Error("registry missing"));

    await expect(
      resolveJobTursoSyncKeysAsync({
        id: "job-broken",
        writeDbIds: [],
        appIds: ["app-1"],
      }),
    ).resolves.toEqual(["job-broken"]);
  });
});
