import { describe, expect, test } from "vitest";
import {
  assertRemoteSeededAfterReplicaPush,
  reseedTursoReplicaFromRemote,
} from "../src/gateway/services/tursoReplica/tursoReplicaProvision.js";

describe("assertRemoteSeededAfterReplicaPush", () => {
  test("allows push when local and remote both empty", () => {
    expect(() =>
      assertRemoteSeededAfterReplicaPush({
        localUserRowsBefore: 0,
        remoteUserRowsAfterPush: 0,
      }),
    ).not.toThrow();
  });

  test("allows push when local had rows and remote received rows", () => {
    expect(() =>
      assertRemoteSeededAfterReplicaPush({
        localUserRowsBefore: 22,
        remoteUserRowsAfterPush: 22,
      }),
    ).not.toThrow();
  });

  test("throws when local had rows but remote is still empty", () => {
    expect(() =>
      assertRemoteSeededAfterReplicaPush({
        localUserRowsBefore: 22,
        remoteUserRowsAfterPush: 0,
      }),
    ).toThrow(/Turso has no user rows/);
  });

  test("throws when remote row count is unknown (-1) but local had data", () => {
    expect(() =>
      assertRemoteSeededAfterReplicaPush({
        localUserRowsBefore: 5,
        remoteUserRowsAfterPush: -1,
      }),
    ).toThrow(/Turso has no user rows/);
  });
});

describe("reseedTursoReplicaFromRemote minExpectedUserRows", () => {
  test("rejects non-replica records before touching files", async () => {
    await expect(
      reseedTursoReplicaFromRemote(
        {
          dbId: "db-test",
          localPath: "/tmp/missing.db",
          tursoShortName: "d-test",
          isolation: "shared",
          status: "active",
          syncMode: "legacy",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        { minExpectedUserRows: 1 },
      ),
    ).rejects.toThrow(/not syncMode=replica/);
  });
});
