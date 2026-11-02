import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoticeService, onNoticesChanged } from "./NoticeService.js";
import type { NoticeInput } from "../../../core/types/notices.js";

const pen = { type: "agent" as const, id: "pen", name: "Pen" };
const done = (chatId: string): NoticeInput => ({
  key: `chat.done:${chatId}`, kind: "chat.done", type: "event", level: "fyi", title: "Reply ready",
  source: pen, owner: { kind: "chat", id: chatId, name: "Chat" },
});
const needsKey = (chatId: string, name = "GITHUB_TOKEN"): NoticeInput => ({
  key: `key.request:${chatId}:${name}`, kind: "key.request", type: "condition", level: "priority",
  title: `Pen needs ${name}`, source: pen, owner: { kind: "chat", id: chatId, name: "Chat" }, resolveGroup: `key:${name}`,
});

describe("NoticeService", () => {
  let dir: string;
  let svc: NoticeService;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "notices-"));
    svc = new NoticeService(path.join(dir, "notices.db"));
  });
  afterEach(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a chat-done FYI as a green event", () => {
    const n = svc.notify(done("a"));
    expect(n).toMatchObject({ mark: "green", type: "event", count: 1 });
    expect(svc.listOpen()).toHaveLength(1);
  });

  it("same key updates in place instead of adding a row", () => {
    svc.notify(done("a"));
    const again = svc.notify(done("a"));
    expect(again?.count).toBe(2);
    expect(svc.listOpen()).toHaveLength(1);
  });

  it("never stores status", () => {
    expect(svc.notify({ ...done("a"), level: "status" })).toBeNull();
    expect(svc.listOpen()).toHaveLength(0);
  });

  it("caps urgent from jobs and agents at priority (blue)", () => {
    expect(svc.notify({ ...needsKey("a"), level: "urgent" })?.mark).toBe("blue");
  });

  it("skips an FYI on the chat you're looking at, but not when the window is in the back", () => {
    svc.setViewing({ owners: [{ kind: "chat", id: "a" }], foreground: true });
    expect(svc.notify(done("a"))).toBeNull();
    svc.setViewing({ owners: [{ kind: "chat", id: "a" }], foreground: false });
    expect(svc.notify(done("a"))?.mark).toBe("green");
  });

  it("looking at a chat clears its events but keeps conditions until fixed", () => {
    svc.notify(done("a"));
    svc.notify(needsKey("a"));
    svc.setViewing({ owners: [{ kind: "chat", id: "a" }], foreground: true });
    const open = svc.listOpen();
    expect(open.map((n) => n.kind)).toEqual(["key.request"]);
    expect(open[0].seenAt).toBeTruthy();
  });

  it("both halves of a split view are seen", () => {
    svc.notify(done("a"));
    svc.notify(done("b"));
    svc.setViewing({ owners: [{ kind: "chat", id: "a" }, { kind: "chat", id: "b" }], foreground: true });
    expect(svc.listOpen()).toHaveLength(0);
  });

  it("resolveGroup answers every request for a key across chats", () => {
    svc.notify(needsKey("a"));
    svc.notify(needsKey("b"));
    svc.notify(needsKey("b", "OPENAI_API_KEY"));
    svc.resolveGroup("key:GITHUB_TOKEN");
    expect(svc.listOpen().map((n) => n.key)).toEqual(["key.request:b:OPENAI_API_KEY"]);
  });

  it("a resolved key can be raised again as a new row", () => {
    svc.notify(needsKey("a"));
    svc.resolve("key.request:a:GITHUB_TOKEN");
    expect(svc.notify(needsKey("a"))?.count).toBe(1);
  });

  it("survives a restart (same file)", () => {
    svc.notify(done("a"));
    svc.close();
    svc = new NoticeService(path.join(dir, "notices.db"));
    expect(svc.listOpen().map((n) => n.key)).toEqual(["chat.done:a"]);
  });

  it("tells listeners the full open list on every change", () => {
    const seen: number[] = [];
    const off = onNoticesChanged((open) => seen.push(open.length));
    svc.notify(done("a"));
    svc.notify(done("b"));
    svc.markSeen("chat", "a");
    svc.markSeen("chat", "zzz");
    off();
    expect(seen).toEqual([1, 2, 1]);
  });
});

describe("NoticeService OS delivery", () => {
  let dir: string;
  let svc: NoticeService;
  const shown: string[] = [];
  let off: () => void;
  // forYou: the app's own notification.show call (notifications:app sets it); default app pref is "For me".
  const appNote = (i: number): NoticeInput & { forYou: boolean } => ({
    key: `app:x:${i}`, kind: "app.notification", type: "event", level: "urgent", title: `Ping ${i}`, forYou: true,
    source: { type: "app", id: "x", name: "Spammy" }, owner: { kind: "app", id: "x", name: "Spammy" },
  });
  beforeEach(async () => {
    const { onNoticeOs } = await import("./NoticeService.js");
    dir = mkdtempSync(path.join(tmpdir(), "notices-os-"));
    svc = new NoticeService(path.join(dir, "notices.db"));
    shown.length = 0;
    off = onNoticeOs(({ notice }) => shown.push(notice.key));
  });
  afterEach(() => {
    off();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("nothing pops while Paprwork is in front", () => {
    svc.setViewing({ owners: [], foreground: true });
    svc.notify(needsKey("a"));
    expect(shown).toEqual([]);
    expect(svc.listOpen()).toHaveLength(1);
  });

  it("pops once in the background; the same key again updates in place without a second ping", () => {
    svc.setViewing({ owners: [], foreground: false });
    const n = svc.notify(needsKey("a"));
    svc.notify(needsKey("a"));
    expect(shown).toEqual(["key.request:a:GITHUB_TOKEN"]);
    expect(svc.deliveriesFor(n!.id)).toEqual([expect.objectContaining({ channel: "os", status: "sent" })]);
  });

  it("caps an app at Priority and at 5 OS pops per 10 minutes; the rest stay as dots", () => {
    svc.setViewing({ owners: [], foreground: false });
    for (let i = 0; i < 8; i++) svc.notify(appNote(i));
    expect(shown).toHaveLength(5);
    expect(svc.listOpen().every((n) => n.level === "priority")).toBe(true);
    const capped = svc.listOpen().find((n) => n.key === "app:x:7")!;
    expect(svc.deliveriesFor(capped.id)[0]).toMatchObject({ status: "capped" });
  });

  it("an app notice that isn't for you stays inside the app: no row, no pop", () => {
    svc.setViewing({ owners: [], foreground: false });
    const { forYou: _f, ...plain } = appNote(1);
    expect(svc.notify(plain)).toBeNull();
    expect(shown).toEqual([]);
  });

  it("an FYI chat reply pops only in the background", () => {
    svc.setViewing({ owners: [], foreground: false });
    svc.notify(done("c"));
    expect(shown).toEqual(["chat.done:c"]);
  });
});

describe("NoticeService settings + clicks", () => {
  let dir: string;
  let svc: NoticeService;
  const shown: string[] = [];
  let off: () => void;
  beforeEach(async () => {
    const { onNoticeOs } = await import("./NoticeService.js");
    dir = mkdtempSync(path.join(tmpdir(), "notices-prefs-"));
    svc = new NoticeService(path.join(dir, "notices.db"));
    shown.length = 0;
    off = onNoticeOs(({ notice }) => shown.push(notice.key));
  });
  afterEach(() => {
    off();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("turning off 'Pen finished a reply' stops the pop but keeps the dot", () => {
    svc.setPrefs({ sources: { chats: { done: { desktop: false } } } });
    svc.setViewing({ owners: [], foreground: false });
    svc.notify(done("c"));
    expect(shown).toEqual([]);
    expect(svc.listOpen()).toHaveLength(1);
  });

  it("settings survive a restart and reset back to defaults", () => {
    svc.setPrefs({ sources: { apps: { needs: { desktop: false } }, "app:crm": { allow: false } } });
    svc.close();
    svc = new NoticeService(path.join(dir, "notices.db"));
    expect(svc.center().prefs).toMatchObject({ sources: { apps: { needs: { desktop: false } }, "app:crm": { allow: false } } });
    expect(svc.resetPrefs().prefs).toEqual(svc.center().defaults);
  });

  it("clicking an OS notification: event done, condition seen but still open", () => {
    svc.setViewing({ owners: [], foreground: false });
    svc.notify(done("c"));
    svc.notify(needsKey("c"));
    svc.markSeenKey("chat.done:c");
    svc.markSeenKey("key.request:c:GITHUB_TOKEN");
    const open = svc.listOpen();
    expect(open.map((n) => n.key)).toEqual(["key.request:c:GITHUB_TOKEN"]);
    expect(open[0].seenAt).toBeTruthy();
  });

  it("the center lists apps that sent you something and recent pops with their why", () => {
    svc.setViewing({ owners: [], foreground: false });
    svc.notify({ key: "app:crm:1", kind: "app.notification", type: "event", level: "priority", title: "Deal moved", forYou: true,
      source: { type: "app", id: "crm", name: "CRM" }, owner: { kind: "app", id: "crm", name: "CRM" } } as NoticeInput);
    const c = svc.center();
    expect(c.apps).toEqual([{ id: "app:crm", name: "CRM" }]);
    expect(c.sources.map((s) => s.id)).toEqual(["chats", "apps", "account", "updates"]);
    expect(c.recent[0]).toMatchObject({ title: "Deal moved", source: "CRM", status: "sent" });
    expect(c.recent[0].why.length).toBeGreaterThan(0);
  });
});
