import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeService } from "./NoticeService.js";

let svc: NoticeService;
vi.mock("./NoticeService.js", async (orig) => {
  const m = await orig<typeof import("./NoticeService.js")>();
  return { ...m, tryNotify: (i: Parameters<NoticeService["notify"]>[0]) => svc.notify(i), tryResolve: (k: string) => svc.resolve(k) };
});
const root = await import("./rootConditions.js");

describe("one root cause, one notice", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "root-")); svc = new NoticeService(path.join(dir, "n.db")); });
  afterEach(() => { svc.close(); rmSync(dir, { recursive: true, force: true }); });

  it("offline is one ambient line with no dot, gone on reconnect", () => {
    root.setOnline(false); root.setOnline(false);
    const open = svc.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ key: "net.offline", mark: "none" });
    root.setOnline(true);
    expect(svc.listOpen()).toHaveLength(0);
  });

  it("every signed-out account folds into one notice; it clears when none are left", () => {
    root.setConnectorsSignedOut(["Linear"]);
    expect(svc.listOpen()[0].title).toBe("Sign in to Linear again");
    root.setConnectorsSignedOut(["Linear", "Notion", "Stripe"]);
    expect(svc.listOpen()).toHaveLength(1);
    expect(svc.listOpen()[0].title).toBe("3 accounts need you to sign in again");
    root.setConnectorsSignedOut([]);
    expect(svc.listOpen()).toHaveLength(0);
  });

  it("credits out is Urgent with Papr copy, cleared by the next finished reply", () => {
    root.creditsOut("papr");
    expect(svc.listOpen()[0]).toMatchObject({ level: "urgent", mark: "blue", title: "You're out of AI credits" });
    root.creditsBack();
    expect(svc.listOpen()).toHaveLength(0);
  });
});
