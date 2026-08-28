import { afterEach, describe, expect, it } from "vitest";
import path from "path";
import {
  isCloudRunSandbox,
  shouldUseCloudSandboxTursoDirect,
  tursoCredsByDbIdFromCloudSources,
} from "../src/gateway/services/cloudAgentGateway/cloudSandboxTursoDirect.js";
import { jobWriteDatabaseEnv } from "../src/gateway/services/jobAppDatabase.js";

describe("cloud sandbox turso direct", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("detects cloud run sandbox paths", () => {
    const root = path.join("/tmp", "papr-cloud-run", "abc", "Papr");
    expect(isCloudRunSandbox(root)).toBe(true);
    expect(isCloudRunSandbox("/Users/me/Papr")).toBe(false);
  });

  it("enables turso direct when Plan A rollout is active", () => {
    const sandbox = path.join("/tmp", "papr-cloud-session", "x", "Papr");
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    delete process.env.PAPR_CLOUD_SANDBOX_TURSO_DIRECT;
    expect(shouldUseCloudSandboxTursoDirect(sandbox)).toBe(true);
  });

  it("can be forced off with PAPR_CLOUD_SANDBOX_TURSO_DIRECT=0", () => {
    const sandbox = path.join("/tmp", "papr-cloud-run", "x", "Papr");
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.PAPR_CLOUD_SANDBOX_TURSO_DIRECT = "0";
    expect(shouldUseCloudSandboxTursoDirect(sandbox)).toBe(false);
  });

  it("maps tursoSources by dbId", () => {
    const map = tursoCredsByDbIdFromCloudSources([
      {
        syncKey: "db-abc123",
        dbPath: "/tmp/x.db",
        databaseShortName: "d-abc123",
        databaseUrl: "libsql://x.turso.io",
        authToken: "tok",
      },
      {
        syncKey: "job-xyz",
        dbPath: "/tmp/y.db",
        databaseShortName: "j-xyz",
        databaseUrl: "libsql://y.turso.io",
        authToken: "tok2",
      },
    ]);
    expect(map.get("db-abc123")).toEqual({
      url: "libsql://x.turso.io",
      authToken: "tok",
    });
    expect(map.has("job-xyz")).toBe(false);
  });

  it("injects turso env vars for write targets", () => {
    const env = jobWriteDatabaseEnv(
      [
        {
          dbId: "db-metrics",
          alias: "Metrics",
          dbPath: "/unused/local.db",
          envKey: "METRICS",
          turso: {
            url: "libsql://metrics.turso.io",
            authToken: "secret",
          },
        },
      ],
      "app-1",
    );

    expect(env.PAPR_DB_METRICS_MODE).toBe("turso");
    expect(env.PAPR_DB_METRICS_URL).toBe("libsql://metrics.turso.io");
    expect(env.PAPR_DB_METRICS_AUTH_TOKEN).toBe("secret");
    expect(env.PAPR_DB_MODE).toBe("turso");
    expect(env.PAPR_DB_URL).toBe("libsql://metrics.turso.io");
    expect(env.APP_DB).toBeUndefined();
  });
});
