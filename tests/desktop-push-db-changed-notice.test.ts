/**
 * Desktop replica push must reach open web tabs' onDbChanged. The old
 * notifyCloudDbChanged needed a server-only secret, so it never fired from desktop.
 */
import { describe, expect, it, vi } from "vitest";
import { noticeDesktopPushDbChanged } from "../src/gateway/services/tursoReplica/desktopPushDbChangedNotice.js";

describe("desktop push db-changed notice", () => {
  it("coalesces a burst into one notice per database", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    for (let i = 0; i < 5; i++) noticeDesktopPushDbChanged({ dbId: "db-a", tursoShortName: "d-a" }, send, 100);
    noticeDesktopPushDbChanged({ dbId: "db-b", tursoShortName: "d-b" }, send, 100);
    await vi.advanceTimersByTimeAsync(150);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({ dbId: "db-a", tursoShortName: "d-a" });
    vi.useRealTimers();
  });

  it("skips sources with no dbId/jobId and never throws on send failure", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error("offline"); });
    noticeDesktopPushDbChanged({ tursoShortName: "d-x" }, send, 10);
    noticeDesktopPushDbChanged({ jobId: "j1", tursoShortName: "j-1" }, send, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("push success path sends it", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/gateway/services/tursoReplica/tursoReplicaRouting.ts", "utf8");
    expect(src).toMatch(/if \(result\.ok\) \{\s*notifyReplicaDbChanged\(source\);[\s\S]{0,200}noticeDesktopPushDbChanged/);
  });
});
