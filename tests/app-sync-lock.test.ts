import { describe, expect, it } from "vitest";
import { appSyncLockHolder, withAppSyncLock } from "../src/gateway/services/syncV3/appSyncLock.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("withAppSyncLock", () => {
  it("publish and Get updates on the same app never overlap", async () => {
    const log: string[] = [];
    const op = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick(20);
      log.push(`${name}:end`);
      return name;
    };
    const [a, b] = await Promise.all([
      withAppSyncLock("app1", "publish", op("publish")),
      withAppSyncLock("app1", "get-updates", op("pull")),
    ]);
    expect([a, b]).toEqual(["publish", "pull"]);
    expect(log).toEqual(["publish:start", "publish:end", "pull:start", "pull:end"]);
  });

  it("different apps run in parallel", async () => {
    const log: string[] = [];
    const op = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick(20);
      log.push(`${name}:end`);
    };
    await Promise.all([
      withAppSyncLock("a", "publish", op("a")),
      withAppSyncLock("b", "publish", op("b")),
    ]);
    expect(log.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
  });

  it("a failed holder still releases the lock", async () => {
    await expect(
      withAppSyncLock("app2", "publish", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withAppSyncLock("app2", "get-updates", async () => "ok")).resolves.toBe("ok");
    expect(appSyncLockHolder("app2")).toBeUndefined();
  });

  it("is re-entrant inside the same chain (no self-deadlock)", async () => {
    const r = await withAppSyncLock("app3", "publish", () =>
      withAppSyncLock("app3", "nested", async () => "inner"),
    );
    expect(r).toBe("inner");
  });

  it("reports the current holder while running", async () => {
    let seen: string | undefined;
    await withAppSyncLock("app4", "get-updates", async () => {
      seen = appSyncLockHolder("app4");
    });
    expect(seen).toBe("get-updates");
  });
});
