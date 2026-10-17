import { afterEach, describe, expect, it } from "vitest";
import { childProcessEnv, clearUserProvidedEnvKeys, markUserProvidedEnvKeys } from "./childProcessEnv.js";
import { execShellCommand } from "./shellExec.js";

const SET = ["PAPR_CLOUD_AGENT_GATEWAY_KEY", "PAPR_CLOUD_APP_HOST_KEY", "GOOGLE_APPLICATION_CREDENTIALS"];

describe("childProcessEnv", () => {
  afterEach(() => {
    for (const k of SET) delete process.env[k];
    delete process.env.STRIPE_KEY;
    delete process.env.GATEWAY_MODE;
    clearUserProvidedEnvKeys();
  });

  it("drops platform service secrets but keeps vault/user env", () => {
    for (const k of SET) process.env[k] = "secret";
    process.env.STRIPE_KEY = "user-vault";
    const env = childProcessEnv({ APP_DB: "/tmp/a.db" });
    expect(env.PAPR_CLOUD_AGENT_GATEWAY_KEY).toBeUndefined();
    expect(env.PAPR_CLOUD_APP_HOST_KEY).toBeUndefined();
    expect(env.STRIPE_KEY).toBe("user-vault");
    expect(env.APP_DB).toBe("/tmp/a.db");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("desktop keeps the user's own Google credentials; cloud strips them", () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/home/me/sa.json";
    expect(childProcessEnv().GOOGLE_APPLICATION_CREDENTIALS).toBe("/home/me/sa.json");
    process.env.GATEWAY_MODE = "cloud_agent";
    expect(childProcessEnv().GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it("cloud keeps a user's own vault GOOGLE_APPLICATION_CREDENTIALS", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/vault/user-sa.json";
    markUserProvidedEnvKeys(["GOOGLE_APPLICATION_CREDENTIALS", "PAPR_CLOUD_APP_HOST_KEY"]);
    process.env.PAPR_CLOUD_APP_HOST_KEY = "svc";
    const env = childProcessEnv();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/vault/user-sa.json");
    expect(env.PAPR_CLOUD_APP_HOST_KEY).toBeUndefined(); // Papr service key: never
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
