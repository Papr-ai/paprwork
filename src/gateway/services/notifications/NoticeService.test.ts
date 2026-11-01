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

  it("caps urgent from jobs and agents at priority (amber)", () => {
    expect(svc.notify({ ...needsKey("a"), level: "urgent" })?.mark).toBe("amber");
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
