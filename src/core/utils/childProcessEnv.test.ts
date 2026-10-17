import { afterEach, describe, expect, it } from "vitest";
import { childProcessEnv, PLATFORM_SECRET_ENV_KEYS } from "./childProcessEnv.js";
import { execShellCommand } from "./shellExec.js";

const SET = ["PAPR_CLOUD_AGENT_GATEWAY_KEY", "PAPR_CLOUD_APP_HOST_KEY", "GOOGLE_APPLICATION_CREDENTIALS"];

describe("childProcessEnv", () => {
  afterEach(() => {
    for (const k of SET) delete process.env[k];
    delete process.env.STRIPE_KEY;
  });

  it("drops platform service secrets but keeps vault/user env", () => {
    for (const k of SET) process.env[k] = "secret";
    process.env.STRIPE_KEY = "user-vault";
    const env = childProcessEnv({ APP_DB: "/tmp/a.db" });
    for (const k of PLATFORM_SECRET_ENV_KEYS) expect(env[k]).toBeUndefined();
    expect(env.STRIPE_KEY).toBe("user-vault");
    expect(env.APP_DB).toBe("/tmp/a.db");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("extra env cannot re-inject a platform secret", () => {
    expect(childProcessEnv({ PAPR_CLOUD_APP_HOST_KEY: "x" }).PAPR_CLOUD_APP_HOST_KEY).toBeUndefined();
  });

  it("a spawned shell cannot read them", async () => {
    process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY = "gw-secret";
    const out = await execShellCommand("env");
    expect(String(out.stdout)).not.toContain("gw-secret");
    expect(String(out.stdout)).not.toContain("PAPR_CLOUD_AGENT_GATEWAY_KEY");
  });
});
