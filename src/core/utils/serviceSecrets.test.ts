import { afterEach, describe, expect, it } from "vitest";
import {
  captureServiceSecrets,
  getServiceSecret,
  resetServiceSecretsForTests,
  serviceSecretsEnv,
} from "./serviceSecrets.js";
import { execShellCommand } from "./shellExec.js";

describe("service secrets", () => {
  afterEach(() => {
    resetServiceSecretsForTests();
    delete process.env.PAPR_CLOUD_APP_HOST_KEY;
    delete process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY;
  });

  it("service keeps its copy; spawned commands never see it", async () => {
    process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY = "svc-gw";
    captureServiceSecrets();
    expect(getServiceSecret("PAPR_CLOUD_AGENT_GATEWAY_KEY")).toBe("svc-gw");
    expect(process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY).toBeUndefined();
    const out = await execShellCommand("env");
    expect(String(out.stdout)).not.toContain("svc-gw");
  });

  it("a user's vault key with the same name still reaches their command", async () => {
    process.env.PAPR_CLOUD_APP_HOST_KEY = "svc-host";
    captureServiceSecrets();
    process.env.PAPR_CLOUD_APP_HOST_KEY = "users-own-value"; // vault injection
    const out = await execShellCommand("env");
    expect(String(out.stdout)).toContain("users-own-value");
    expect(String(out.stdout)).not.toContain("svc-host");
    // ...and the service never picks up the user's value
    expect(getServiceSecret("PAPR_CLOUD_APP_HOST_KEY")).toBe("svc-host");
  });

  it("internal Papr workers get the service copy explicitly", () => {
    process.env.PAPR_CLOUD_APP_HOST_KEY = "svc-host";
    captureServiceSecrets();
    expect(serviceSecretsEnv()).toEqual({ PAPR_CLOUD_APP_HOST_KEY: "svc-host" });
  });
});
