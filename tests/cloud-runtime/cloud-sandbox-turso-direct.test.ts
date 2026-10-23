import { afterEach, describe, expect, it } from "vitest";
import path from "path";
import {
  isCloudRunSandbox,
  shouldUseCloudSandboxTursoDirect,
} from "../../src/gateway/services/cloudAgentGateway/cloudSandboxTursoDirect.js";
import { jobWriteDatabaseEnv } from "../../src/gateway/services/jobAppDatabase.js";

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
});
