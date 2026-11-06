/** Needs you: what counts, Later timing, mutes. The list in Focus and the count on Pen both read this. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusReason, laterList, laterUntil, mutedSources, needsYou, noticeLabels, whenLabel } from "./needsYou.js";
import { DEFAULT_NOTICE_PREFS, mergePrefs } from "./prefs.js";
import type { Notice } from "../types/notices.js";

const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m);
const n = (o: Partial<Notice> = {}): Notice => ({
  id: o.key ?? "k", key: "k", kind: "key.request", type: "condition", level: "priority", mark: "blue", count: 1,
  title: "Pen needs GITHUB_TOKEN", source: { type: "agent", id: "pen", name: "Pen" }, owner: { kind: "account", id: "settings", name: "Settings" },
  createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z", ...o,
});
const billing = { type: "billing" as const, id: "credits", name: "Billing" };


// The fixtures use fixed Nov 3 2026 times, and mergePrefs drops a muteUntil
// that is already past by the real clock. Freeze Date so they don't expire.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("laterUntil", () => {
  it("morning: back at 3 PM today", () => expect(laterUntil(at(10, 40))).toEqual(at(15)));
  it("just before noon still means 3 PM", () => expect(laterUntil(at(11, 59))).toEqual(at(15)));
  it("afternoon: back tomorrow 9 AM", () => expect(laterUntil(at(16, 15))).toEqual(new Date(2026, 10, 4, 9)));
  it("noon counts as afternoon", () => expect(laterUntil(at(12))).toEqual(new Date(2026, 10, 4, 9)));
  it("labels say today / tomorrow", () => {
    expect(whenLabel(at(15), at(10))).toMatch(/today$/);
    expect(whenLabel(new Date(2026, 10, 4, 9), at(16))).toMatch(/^tomorrow /);
  });
});

describe("needsYou", () => {
  const now = at(10).getTime();
  it("Priority and Urgent are in it; FYI never is", () => {
    const list = needsYou([n({ key: "a" }), n({ key: "b", level: "fyi", mark: "green", kind: "chat.done" })], DEFAULT_NOTICE_PREFS, now);
    expect(list.map((x) => x.key)).toEqual(["a"]);
  });
  it("Urgent first, then newest", () => {
    const list = needsYou([
      n({ key: "old", updatedAt: "2026-11-03T09:00:00Z" }),
      n({ key: "new", updatedAt: "2026-11-03T11:00:00Z" }),
      n({ key: "urgent", level: "urgent", source: billing, updatedAt: "2026-11-03T08:00:00Z" }),
    ], DEFAULT_NOTICE_PREFS, now);
    expect(list.map((x) => x.key)).toEqual(["urgent", "new", "old"]);
  });
  it("Later hides it until then, then it's back", () => {
    const item = n({ laterUntil: at(15).toISOString() });
    expect(needsYou([item], DEFAULT_NOTICE_PREFS, now)).toHaveLength(0);
    expect(laterList([item], now)).toHaveLength(1);
    expect(needsYou([item], DEFAULT_NOTICE_PREFS, at(15, 1).getTime())).toHaveLength(1);
  });
  it("a muted source is out until the mute ends; Urgent ignores mute", () => {
    const prefs = mergePrefs(DEFAULT_NOTICE_PREFS, { sources: { chats: { muteUntil: at(11).toISOString() } } });
    const id = noticeLabels(n()).sourceId;
    const muted = mergePrefs(DEFAULT_NOTICE_PREFS, { sources: { [id]: { muteUntil: at(11).toISOString() } } });
    expect(needsYou([n()], muted, now)).toHaveLength(0);
    expect(needsYou([n()], muted, at(11, 1).getTime())).toHaveLength(1);
    expect(mutedSources(muted, now)).toEqual([{ id, until: at(11).toISOString() }]);
    expect(needsYou([n({ level: "urgent", source: billing })], mergePrefs(prefs, { sources: { account: { muteUntil: at(11).toISOString() } } }), now)).toHaveLength(1);
  });
  it("owned by a chat or app: stays on its dot until it has waited a day, then comes in with the reason", () => {
    const chat = n({ key: "chat", owner: { kind: "chat", id: "c", name: "Chat" } });
    const proposal = n({ key: "p", kind: "proposal", owner: { kind: "app", id: "a", name: "CRM" }, source: { type: "platform", id: "cloud", name: "Papr" } });
    expect(needsYou([chat, proposal], DEFAULT_NOTICE_PREFS, now)).toHaveLength(0);
    const tomorrow = Date.parse("2026-11-04T10:00:00Z");
    expect(needsYou([chat, proposal], DEFAULT_NOTICE_PREFS, tomorrow)).toHaveLength(2);
    expect(focusReason(chat, DEFAULT_NOTICE_PREFS, tomorrow)).toBe("Waiting since yesterday");
  });
  it("no home (account, billing, updates): always in, no reason", () => {
    const update = n({ key: "u", kind: "app.update_ready", source: { type: "platform", id: "updater", name: "Papr Work" } });
    expect(needsYou([update], DEFAULT_NOTICE_PREFS, now)).toHaveLength(1);
    expect(focusReason(update, DEFAULT_NOTICE_PREFS, now)).toBe("");
  });
  it("a source set to always or never overrides Pen", () => {
    const chat = n({ key: "chat", owner: { kind: "chat", id: "c", name: "Chat" } });
    expect(needsYou([chat], mergePrefs(DEFAULT_NOTICE_PREFS, { sources: { chats: { focus: "always" } } }), now)).toHaveLength(1);
    const never = mergePrefs(DEFAULT_NOTICE_PREFS, { sources: { chats: { focus: "never" } } });
    expect(needsYou([chat], never, Date.parse("2026-11-05T10:00:00Z"))).toHaveLength(0);
    expect(needsYou([n({ key: "x", level: "urgent", source: billing, owner: { kind: "chat", id: "c", name: "Chat" } })], never, now)).toHaveLength(1);
  });
  it("focus mode survives clean and drops back to default when set to pen", () => {
    const p = mergePrefs(DEFAULT_NOTICE_PREFS, { sources: { chats: { focus: "always" } } });
    expect(p.sources.chats.focus).toBe("always");
    expect(mergePrefs(p, { sources: { chats: { focus: "pen" } } }).sources.chats).toBeUndefined();
  });
  it("an app can't make itself Urgent to jump the queue", () => {
    const app = n({ key: "app", level: "urgent", source: { type: "app", id: "x", name: "X" } });
    const list = needsYou([app, n({ key: "b", level: "urgent", source: billing })], DEFAULT_NOTICE_PREFS, now);
    expect(list[0].key).toBe("b");
  });
});
