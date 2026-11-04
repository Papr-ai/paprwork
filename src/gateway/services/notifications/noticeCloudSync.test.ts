import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeService, onNoticeMarked, type NoticeMarkChange, type RemoteNotice } from "./NoticeService.js";
import { batches } from "./noticeCloudSync.js";

const people = { type: "platform" as const, id: "people", name: "People" };
const ask = (over: Partial<RemoteNotice> = {}): RemoteNotice => ({
  key: "mention:m1", kind: "mention", type: "event", level: "priority", title: "Amir: Complete the Pricing Page FAQ",
  source: people, owner: { kind: "account", id: "people", name: "People" }, state: "open", updatedAt: "2026-11-04T10:00:00Z", ...over,
});

describe("NoticeService.applyRemote", () => {
  let dir: string;
  let svc: NoticeService;
  let marks: NoticeMarkChange[];
  let off: () => void;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "notices-cloud-"));
    svc = new NoticeService(path.join(dir, "notices.db"));
    marks = [];
    off = onNoticeMarked((m) => marks.push(m));
  });
  afterEach(() => { off(); svc.close(); rmSync(dir, { recursive: true, force: true }); });

  it("adds a notice from another device and never echoes it back", () => {
    expect(svc.applyRemote(ask())).toBe(true);
    expect(svc.listOpen().map((n) => n.key)).toEqual(["mention:m1"]);
    expect(marks).toEqual([]);
  });

  it("done elsewhere clears it here", () => {
    svc.applyRemote(ask());
    svc.applyRemote(ask({ state: "done", updatedAt: "2026-11-04T11:00:00Z" }));
    expect(svc.listOpen()).toEqual([]);
    expect(marks).toEqual([]);
  });

  it("later elsewhere takes it out of Needs you here; seen keeps it", () => {
    svc.applyRemote(ask());
    svc.applyRemote(ask({ state: "later", laterUntil: "2026-11-05T09:00:00.000Z", updatedAt: "2026-11-04T11:00:00Z" }));
    expect(svc.listOpen()[0].laterUntil).toBe("2026-11-05T09:00:00.000Z");
    svc.applyRemote(ask({ state: "seen", updatedAt: "2026-11-04T12:00:00Z" }));
    const n = svc.listOpen()[0];
    expect(n.seenAt).toBeTruthy();
    expect(n.laterUntil).toBeUndefined();
  });

  it("keeps the chat this desktop opened for it", () => {
    svc.notify({ ...ask(), owner: { kind: "chat", id: "c9", name: "@Amir: FAQ" } });
    svc.applyRemote(ask({ title: "Amir is checking in: Complete the Pricing Page FAQ", updatedAt: "2999-01-01T00:00:00Z" }));
    const n = svc.listOpen()[0];
    expect(n.owner).toMatchObject({ kind: "chat", id: "c9" });
    expect(n.title).toContain("checking in");
  });

  it("local actions are queued for the cloud", () => {
    svc.applyRemote(ask());
    svc.later("mention:m1", new Date("2026-11-04T10:00:00"));
    svc.unlater("mention:m1");
    svc.markSeen("account", "people");
    expect(marks.map((m) => [m.keys, m.state])).toEqual([[["mention:m1"], "later"], [["mention:m1"], "open"], [["mention:m1"], "done"]]);
  });
});

describe("batches", () => {
  it("last mark per key wins, one batch per state", () => {
    const out = batches([
      { keys: ["a", "b"], state: "seen" }, { keys: ["a"], state: "done" },
      { keys: ["c"], state: "later", laterUntil: "x" }, { keys: ["d"], state: "later", laterUntil: "x" },
    ]);
    expect(out).toEqual([{ keys: ["a"], state: "done" }, { keys: ["b"], state: "seen" }, { keys: ["c", "d"], state: "later", laterUntil: "x" }].sort(() => 0).filter(Boolean).sort((x, y) => (x.keys[0] < y.keys[0] ? -1 : 1)));
  });
});

describe("pullNotices", () => {
  it("first pull is silent, then follows the cursor; 404 means the server has no list", async () => {
    vi.resetModules();
    const root = mkdtempSync(path.join(tmpdir(), "notices-root-"));
    vi.doMock("../../../core/utils/paprRoot.js", () => ({ getPaprRoot: () => root }));
    const m = await import("./noticeCloudSync.js");
    const seen: [string, boolean][] = [];
    const pages = [{ notices: [ask()], cursor: "5", more: false }, { notices: [ask({ key: "k2" })], cursor: "9", more: false }];
    const asked: (string | undefined)[] = [];
    const deps = { fetchPage: async (s?: string) => { asked.push(s); const b = pages.shift(); return b ? { status: 200, body: b } : { status: 404 }; },
      apply: (n: RemoteNotice, silent: boolean) => { seen.push([n.key, silent]); } };
    expect(await m.pullNotices(deps)).toBe(1);
    expect(await m.pullNotices(deps)).toBe(1);
    expect(m.cloudNoticesAvailable()).toBe(true);
    expect(await m.pullNotices(deps)).toBeNull();
    expect(m.cloudNoticesAvailable()).toBe(false);
    expect(asked).toEqual([undefined, "5", "9"]);
    expect(seen).toEqual([["mention:m1", true], ["k2", false]]);
    rmSync(root, { recursive: true, force: true });
  });
});
