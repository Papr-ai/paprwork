import { afterEach, describe, expect, it } from "vitest";
import {
  resetSchemaStatusCacheForTests,
  toAppRevisionSchemaPayload,
} from "../src/gateway/services/appRuntime/cloudAppSchemaGate.js";

describe("cloud app schema gate payload", () => {
  afterEach(() => {
    resetSchemaStatusCacheForTests();
  });

  it("marks schemaReady when gate is not blocked", () => {
    expect(
      toAppRevisionSchemaPayload("rev-1", {
        blocked: false,
        requiredSchemaVersion: "0002_init.sql",
        remoteSchemaVersion: "0002_init.sql",
        pinnedRevision: null,
      }),
    ).toEqual({
      revision: "rev-1",
      requiredSchemaVersion: "0002_init.sql",
      remoteSchemaVersion: "0002_init.sql",
      schemaReady: true,
      schemaSyncing: false,
    });
  });

  it("reports ready and serves pre-update revision when Turso lags bundle", () => {
    expect(
      toAppRevisionSchemaPayload("rev-2", {
        blocked: true,
        requiredSchemaVersion: "0005_add.sql",
        remoteSchemaVersion: "0003_old.sql",
        pinnedRevision: "rev-1",
      }),
    ).toEqual({
      revision: "rev-1",
      requiredSchemaVersion: "0005_add.sql",
      remoteSchemaVersion: "0003_old.sql",
      schemaReady: true,
      schemaSyncing: false,
    });
  });

  it("treats apps without required schema as ready", () => {
    expect(
      toAppRevisionSchemaPayload("rev-3", {
        blocked: false,
        requiredSchemaVersion: null,
        remoteSchemaVersion: null,
        pinnedRevision: null,
      }),
    ).toMatchObject({
      schemaReady: true,
      schemaSyncing: false,
    });
  });
});
