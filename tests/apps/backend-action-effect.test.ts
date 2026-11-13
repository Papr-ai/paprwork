import { describe, expect, it } from "vitest";
import {
  assertActionEffectAllowed,
  stripDirectDbCredentials,
} from "../../src/gateway/services/appRuntime/CloudAppBackendService.js";

const status = (fn: () => void): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

describe("backend action effect gate", () => {
  const ro = { canWrite: false };
  const rw = { canWrite: true };

  it("403s write and external actions on read-only links", () => {
    expect(status(() => assertActionEffectAllowed("save", "write", ro))).toBe(403);
    expect(status(() => assertActionEffectAllowed("send", "external", ro))).toBe(403);
  });

  it("allows read and undeclared actions on read-only links (proxy still blocks writes)", () => {
    expect(status(() => assertActionEffectAllowed("list", "read", ro))).toBeUndefined();
    expect(status(() => assertActionEffectAllowed("legacy", undefined, ro))).toBeUndefined();
  });

  it("allows everything with write access, and on desktop (no cloud access)", () => {
    for (const e of ["read", "write", "external", undefined]) {
      expect(status(() => assertActionEffectAllowed("a", e, rw))).toBeUndefined();
      expect(status(() => assertActionEffectAllowed("a", e, undefined))).toBeUndefined();
    }
  });
});

describe("stripDirectDbCredentials", () => {
  it("removes Turso URL/token for every source and keeps aliases + proxy-compatible keys", () => {
    const out = stripDirectDbCredentials({
      PAPR_LINKED_DB_ALIASES: "main",
      PAPR_DB_MAIN_ALIAS: "main",
      PAPR_DB_MAIN_ID: "db-1",
      PAPR_DB_MAIN_MODE: "turso",
      PAPR_DB_MAIN_URL: "libsql://x",
      PAPR_DB_MAIN_AUTH_TOKEN: "secret",
      PAPR_DB_MODE: "turso",
      PAPR_DB_URL: "libsql://x",
      PAPR_DB_AUTH_TOKEN: "secret",
      APP_DB_ALIAS: "main",
      PAPR_ACTIVE_SOURCE_ID: "main",
    });
    expect(Object.values(out)).not.toContain("secret");
    expect(Object.values(out)).not.toContain("libsql://x");
    expect(out.PAPR_DB_MAIN_ALIAS).toBe("main");
    expect(out.PAPR_ACTIVE_SOURCE_ID).toBe("main");
    expect(out.PAPR_DB_MODE).toBeUndefined();
  });

  it("keeps local-mode env untouched", () => {
    const env = { PAPR_DB_MODE: "local", APP_DB: "/tmp/a.db", PAPR_DB_MAIN: "/tmp/a.db", PAPR_DB_MAIN_MODE: "local" };
    expect(stripDirectDbCredentials(env)).toEqual(env);
  });
});

describe("checkBundleFingerprint", () => {
  it("reports a stale bundle instead of refusing (accepted proposal changed the handler)", async () => {
    const { checkBundleFingerprint } = await import(
      "../../src/gateway/services/appRuntime/CloudAppBackendService.js"
    );
    const { createHash } = await import("node:crypto");
    const h = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    const bundle = { actions: { ping: { sha256: h("def run(): return 1") } } };

    expect(checkBundleFingerprint("ping", "def run(): return 1", bundle)).toEqual({ stale: false });
    expect(checkBundleFingerprint("ping", "def run(): return 2", bundle)).toMatchObject({ stale: true });
    expect(checkBundleFingerprint("other", "x", bundle)).toEqual({ stale: false });
    expect(checkBundleFingerprint("ping", "x", null)).toEqual({ stale: false });
  });
});
