import { describe, expect, it } from "vitest";
import { ephemeralGitEnv } from "../src/gateway/utils/ephemeralGitEnv.js";

describe("ephemeralGitEnv", () => {
  it("disables git credential storage for ephemeral GitHub tokens", () => {
    const env = ephemeralGitEnv({ FOO: "bar" });
    expect(env.FOO).toBe("bar");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
  });
});
