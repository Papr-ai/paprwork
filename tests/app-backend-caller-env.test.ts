import { describe, expect, it } from "vitest";
import { buildBackendActionEnv } from "../src/gateway/services/appRuntime/appBackendRunner.js";
import {
  VERIFIED_CALLER_EMAIL_PARAM,
  VERIFIED_CALLER_USER_ID_PARAM,
} from "../src/gateway/services/appRuntime/miniAppAccess.js";

describe("buildBackendActionEnv caller identity", () => {
  it("injects verified caller env vars when logged in", () => {
    const env = buildBackendActionEnv({
      appId: "app-1",
      action: "get-scores",
      params: { limit: "10" },
      loggedIn: true,
      callerIdentity: { userId: "user-abc", email: "dev@papr.ai" },
    });

    expect(env[VERIFIED_CALLER_USER_ID_PARAM]).toBe("user-abc");
    expect(env[VERIFIED_CALLER_EMAIL_PARAM]).toBe("dev@papr.ai");
    expect(JSON.parse(env.PAPR_ACTION_PARAMS ?? "{}")).toMatchObject({
      limit: "10",
      [VERIFIED_CALLER_USER_ID_PARAM]: "user-abc",
      [VERIFIED_CALLER_EMAIL_PARAM]: "dev@papr.ai",
    });
  });

  it("overrides spoofed caller params from the client", () => {
    const env = buildBackendActionEnv({
      appId: "app-1",
      action: "claim",
      params: {
        [VERIFIED_CALLER_USER_ID_PARAM]: "spoofed-leader",
        passcode: "ABC123",
      },
      loggedIn: true,
      callerIdentity: { userId: "verified-user" },
    });

    expect(env[VERIFIED_CALLER_USER_ID_PARAM]).toBe("verified-user");
    const params = JSON.parse(env.PAPR_ACTION_PARAMS ?? "{}") as Record<string, string>;
    expect(params[VERIFIED_CALLER_USER_ID_PARAM]).toBe("verified-user");
    expect(params.passcode).toBe("ABC123");
    expect(env[`PAPR_PARAM_${VERIFIED_CALLER_USER_ID_PARAM}`]).toBe("verified-user");
    expect(env.PAPR_PARAM_passcode).toBe("ABC123");
  });

  it("omits caller env vars when logged out", () => {
    const env = buildBackendActionEnv({
      appId: "app-1",
      action: "ping",
      params: { ping: "1" },
      loggedIn: false,
      callerIdentity: { userId: "should-not-appear" },
    });

    expect(env[VERIFIED_CALLER_USER_ID_PARAM]).toBeUndefined();
    expect(env[VERIFIED_CALLER_EMAIL_PARAM]).toBeUndefined();
    const params = JSON.parse(env.PAPR_ACTION_PARAMS ?? "{}") as Record<string, string>;
    expect(params[VERIFIED_CALLER_USER_ID_PARAM]).toBeUndefined();
  });
});
