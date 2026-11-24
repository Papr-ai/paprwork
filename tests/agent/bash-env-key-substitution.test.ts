/**
 * Regression: custom-key references in the bash tool's `env` parameter were
 * never substituted. `env: { S: "${MY_KEY}" }` reached the process as the
 * literal placeholder (exit 0, no warning), so scripts silently authenticated
 * with garbage. Substitution must cover env values exactly like `command`.
 */
import { describe, it, expect } from "vitest";
import { __testing } from "../../src/core/tools/bash";

const { joinForSubstitution, splitAfterSubstitution, envHasKeyRef, keyRefUsed, substituteEnvKeyRefs } =
  __testing;

const ref = (name: string) => "$" + "{" + name + "}";

describe("bash env key substitution", () => {
  it("detects key references inside env values", () => {
    expect(envHasKeyRef({ S: ref("MY_KEY") })).toBe(true);
    expect(envHasKeyRef({ S: "plain" })).toBe(false);
    expect(envHasKeyRef({ S: ref("MS_TENANT_ID2") })).toBe(true);
  });

  it("counts a key as used when only env references it", () => {
    expect(keyRefUsed("MY_KEY", "python3 run.py", { S: ref("MY_KEY") })).toBe(true);
    expect(keyRefUsed("MY_KEY", "python3 run.py", { S: "x" })).toBe(false);
  });

  it("substitutes env values in place (no-permission path)", () => {
    const env = { S: ref("MY_KEY"), T: "prefix-" + ref("OTHER"), U: "keep" };
    substituteEnvKeyRefs(env, { MY_KEY: "secret-1", OTHER: "secret-2" });
    expect(env).toEqual({ S: "secret-1", T: "prefix-secret-2", U: "keep" });
  });

  it("round-trips command + env through one substitution pass", () => {
    const env = { S: ref("MY_KEY"), EMPTY: "" };
    const joined = joinForSubstitution("echo " + ref("MY_KEY"), env);
    const substituted = joined.split(ref("MY_KEY")).join("secret-1");
    const command = splitAfterSubstitution(substituted, env);
    expect(command).toBe("echo secret-1");
    expect(env).toEqual({ S: "secret-1", EMPTY: "" });
  });

  it("leaves env untouched when there are no env vars", () => {
    const env: Record<string, string> = {};
    expect(splitAfterSubstitution(joinForSubstitution("ls", env), env)).toBe("ls");
  });
});
