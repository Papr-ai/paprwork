import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeService } from "./NoticeService.js";

let svc: NoticeService;
vi.mock("./NoticeService.js", async (orig) => {
  const m = await orig<typeof import("./NoticeService.js")>();
  return { ...m, tryNotify: (i: Parameters<NoticeService["notify"]>[0]) => svc.notify(i), tryResolve: (k: string) => svc.resolve(k), tryListOpen: () => svc.listOpen() };
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

  it("server credits-out replaces the desktop one: no second notice for the same problem", () => {
    svc.applyRemote({ key: "billing.out:o", kind: "billing.credits_out", type: "condition", level: "urgent", title: "Your team is out of AI credits",
      source: { type: "billing", id: "billing", name: "Billing" }, owner: { kind: "account", id: "billing", name: "Billing", section: "billing" },
      state: "open", updatedAt: new Date().toISOString() } as never, { silent: true });
    root.creditsOut("papr");
    expect(svc.listOpen().map((x) => x.key)).toEqual(["billing.out:o"]);
  });
});
