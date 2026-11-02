import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTICE_PREFS, cleanPrefs, sourcePref } from "../../../core/notifications/prefs.js";
import { PrefsStore } from "./noticePrefs.js";

describe("notice prefs", () => {
  it("starts on the defaults with nothing stored", () => {
    const s = new PrefsStore(new Database(":memory:"));
    expect(s.effective()).toEqual(DEFAULT_NOTICE_PREFS);
  });

  it("keeps only what differs from the default, so you follow future defaults", () => {
    const s = new PrefsStore(new Database(":memory:"));
    s.set({ sources: { chats: { done: { desktop: false } }, "app:a": { allow: false } }, types: { "apps/proposal.review": false } });
    expect(s.effective()).toEqual({ version: 2, sources: { chats: { done: { desktop: false } }, "app:a": { allow: false } }, types: { "apps/proposal.review": false } });
    s.set({ sources: { chats: { done: { desktop: true } }, "app:a": { allow: true } }, types: { "apps/proposal.review": true } });
    expect(s.effective()).toEqual(DEFAULT_NOTICE_PREFS);
  });

  it("drops junk instead of breaking routing", () => {
    expect(cleanPrefs({ version: 2, sources: { chats: { allow: "no", needs: { desktop: false, loud: true } }, "": {} }, types: { x: false, "a/b": "off" }, evil: 1 }))
      .toEqual({ version: 2, sources: { chats: { needs: { desktop: false } } }, types: {} });
  });

  it("carries Stage 1 settings over once", () => {
    const db = new Database(":memory:");
    const s = new PrefsStore(db);
    db.prepare("INSERT INTO notice_prefs (id, json, updated_at) VALUES (1, ?, '')")
      .run(JSON.stringify({ priorityOs: false, chatDoneOs: false, apps: { crm: "off", notes: "all" } }));
    const p = s.effective();
    expect(sourcePref(p, "chats")).toEqual({ allow: true, needs: { desktop: false, badge: true }, done: { desktop: false, badge: true } });
    expect(sourcePref(p, "apps").needs.desktop).toBe(false);
    expect(sourcePref(p, "app:crm").allow).toBe(false);
    expect(sourcePref(p, "app:notes").needs.desktop).toBe(false);
    expect(JSON.parse((db.prepare("SELECT json FROM notice_prefs").get() as { json: string }).json).version).toBe(2);
  });
});
