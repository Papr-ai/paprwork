import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoticeService, onNoticeOs } from "./NoticeService.js";
import { countOffs } from "./noticeStats.js";
import type { NoticeInput } from "../../../core/types/notices.js";

const pen = { type: "agent" as const, id: "pen", name: "Pen" };
const done = (chatId: string): NoticeInput => ({
  key: `chat.done:${chatId}`, kind: "chat.done", type: "event", level: "fyi", title: "Reply ready",
  source: pen, owner: { kind: "chat", id: chatId, name: "Chat" },
});
const needsKey = (chatId: string): NoticeInput => ({
  key: `key.request:${chatId}:K`, kind: "key.request", type: "condition", level: "priority",
  title: "Pen needs K", source: pen, owner: { kind: "chat", id: chatId, name: "Chat" },
});

describe("notification stats + Do Not Disturb", () => {
  let dir: string;
  let svc: NoticeService;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "notice-stats-"));
    svc = new NoticeService(path.join(dir, "notices.db"));
    svc.setViewing({ owners: [], foreground: false });
  });
  afterEach(() => { svc.close(); rmSync(dir, { recursive: true, force: true }); });

  it("counts new notices once (a repeat isn't counted), desktop notifications, and time to done", () => {
    svc.notify(done("a"));
    svc.notify(done("a"));
    svc.notify(needsKey("b"));
    svc.markSeen("chat", "a");
    const s = svc.statsSummary(7);
    expect(s.totals.raised).toBe(2);
    expect(s.totals.os).toBe(2);
    expect(s.bySource.find((x) => x.source === "chats")).toMatchObject({ raised: 2, os: 2 });
    expect(s.medianMinutesToDone).toBe(0);
    expect(s.perDay).toBeCloseTo(0.3, 1);
  });

  it("Do Not Disturb keeps the dot, holds the desktop notification, and lifts when turned off", () => {
    svc.setPrefs({ pauseUntil: new Date(Date.now() + 3600_000).toISOString() });
    expect(svc.notify(needsKey("a"))?.mark).toBe("blue");
    expect(svc.statsSummary().totals).toMatchObject({ raised: 1, os: 0, paused: 1 });
    expect(svc.deliveriesFor(svc.listOpen()[0].id)).toHaveLength(0);
    svc.setPrefs({ pauseUntil: null });
    expect(svc.prefs.pauseUntil).toBeUndefined();
    svc.notify(needsKey("b"));
    expect(svc.statsSummary().totals.os).toBe(1);
  });

  it("a pause time in the past is ignored; Do Not Disturb survives a restart", () => {
    svc.setPrefs({ pauseUntil: new Date(Date.now() - 1000).toISOString() });
    expect(svc.prefs.pauseUntil).toBeUndefined();
    const until = new Date(Date.now() + 3600_000).toISOString();
    svc.setPrefs({ pauseUntil: until });
    svc.close();
    svc = new NoticeService(path.join(dir, "notices.db"));
    expect(svc.prefs.pauseUntil).toBe(until);
  });

  it("counts what your settings turn off and what they then drop", () => {
    svc.setPrefs({ types: { "chats/chat.done": false }, sources: { updates: { allow: false } } });
    svc.notify(done("a"));
    const t = svc.statsSummary().totals;
    expect(t.mute).toBe(2);
    expect(t.muted).toBe(1);
    expect(t.raised).toBe(0);
  });

  it("countOffs counts each false in a patch", () => {
    expect(countOffs({ sources: { a: { allow: false, needs: { desktop: false, badge: true } } }, types: { "a/b": true } })).toBe(2);
    expect(countOffs({ pauseUntil: "x" })).toBe(0);
  });

  it("Show previews is saved sparse, travels with each desktop notification, and resets", () => {
    const seen: string[] = [];
    const off = onNoticeOs((d) => seen.push(d.previews));
    svc.notify(needsKey("a"));
    svc.setPrefs({ previews: "never" });
    expect(svc.prefs.previews).toBe("never");
    svc.notify(needsKey("b"));
    svc.setPrefs({ previews: "unlocked" });
    expect(svc.prefs.previews).toBeUndefined();
    off();
    expect(seen).toEqual(["unlocked", "never"]);
  });
});
