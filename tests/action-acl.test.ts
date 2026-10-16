import { describe, expect, it } from "vitest";
import {
  assertActionAclAllowed,
  bindCallerId,
  callerIdParamIndex,
  parseActionAcl,
} from "../src/gateway/services/appRuntime/actionAcl.js";
import { parseAppBackendManifest } from "../src/gateway/services/appRuntime/appBackendManifest.js";

const status = (fn: () => void) => { try { fn(); return 200; } catch (e) { return (e as { status: number }).status; } };
const pub = { mode: "team" as const, userId: "pub1" };

describe("manifest acl", () => {
  it("parses valid values, rejects junk", () => {
    expect(parseActionAcl("a", "caller")).toBe("caller");
    expect(parseActionAcl("a", ["u1", "u1"])).toEqual(["u1"]);
    expect(parseActionAcl("a", undefined)).toBeUndefined();
    expect(() => parseActionAcl("a", "everyone")).toThrow(/acl/);
    expect(() => parseActionAcl("a", ["bad id!"])).toThrow(/acl/);
    const m = parseAppBackendManifest({ version: 1, actions: { mine: { handler: "m.py", runtime: "python", acl: "caller" } } });
    expect(m.actions.mine.acl).toBe("caller");
  });
});

describe("who may run an action", () => {
  it("public: anyone", () => expect(status(() => assertActionAclAllowed("a", undefined, pub, undefined))).toBe(200));
  it("caller: sign-in required", () => {
    expect(status(() => assertActionAclAllowed("a", "caller", pub, undefined))).toBe(401);
    expect(status(() => assertActionAclAllowed("a", "caller", pub, "u9"))).toBe(200);
  });
  it("members: team modes only", () => {
    expect(status(() => assertActionAclAllowed("a", "members", { mode: "team", userId: "pub1" }, "m1"))).toBe(200);
    expect(status(() => assertActionAclAllowed("a", "members", { mode: "public_read" as never, userId: "pub1" }, "m1"))).toBe(403);
    expect(status(() => assertActionAclAllowed("a", "members", { mode: "public_read" as never, userId: "pub1" }, "pub1"))).toBe(200);
  });
  it("user list", () => {
    expect(status(() => assertActionAclAllowed("a", ["u1"], pub, "u1"))).toBe(200);
    expect(status(() => assertActionAclAllowed("a", ["u1"], pub, "u2"))).toBe(403);
  });
});

describe(":caller_id is bound by the host", () => {
  it("finds SQLite's parameter index", () => {
    expect(callerIdParamIndex("SELECT * FROM n WHERE owner = :caller_id")).toBe(1);
    expect(callerIdParamIndex("SELECT * FROM n WHERE id = ? AND owner = :caller_id")).toBe(2);
    expect(callerIdParamIndex("SELECT * FROM n WHERE owner = :caller_id AND id = ?")).toBe(1);
    expect(callerIdParamIndex("SELECT ':caller_id' -- :caller_id")).toBeNull();
  });
  it("splices the verified id; handler args can't replace it", () => {
    expect(bindCallerId("SELECT * FROM n WHERE id = ? AND owner = :caller_id", [5], "me")).toEqual([5, "me"]);
    expect(bindCallerId("SELECT * FROM n WHERE owner = :caller_id AND id = ?", [5], "me")).toEqual(["me", 5]);
    // handler tries to pass someone else's id positionally → clear 400, never bound
    expect(status(() => bindCallerId("SELECT * FROM n WHERE owner = :caller_id", ["victim"], "me"))).toBe(400);
    expect(bindCallerId("SELECT * FROM n WHERE owner = :caller_id", { caller_id: "victim" }, "me")).toEqual({ ":caller_id": "me" });
  });
  it("anonymous caller on a scoped query → 401; unscoped SQL untouched", () => {
    expect(status(() => bindCallerId("SELECT 1 WHERE :caller_id", [], undefined))).toBe(401);
    expect(bindCallerId("SELECT * FROM tags WHERE id = ?", [1], undefined)).toEqual([1]);
  });
});

describe(":caller_id spoof attempts", () => {
  it("rejects an extra positional arg aimed at :caller_id with a clear 400", async () => {
    const { bindCallerId } = await import("../src/gateway/services/appRuntime/actionAcl.js");
    expect(() => bindCallerId("SELECT :caller_id", ["EVIL"], "u1")).toThrow(/Don't pass a value for :caller_id/);
    expect(() => bindCallerId("SELECT ?, :caller_id", ["x", "EVIL"], "u1")).toThrow(/Don't pass a value/);
    expect(bindCallerId("SELECT ?, :caller_id", ["x"], "u1")).toEqual(["x", "u1"]);
    expect(bindCallerId("SELECT :caller_id, ?", ["x"], "u1")).toEqual(["u1", "x"]);
  });
});
