import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTICE_PREFS } from "../../../core/notifications/route.js";
import { PrefsStore, cleanPrefs } from "./noticePrefs.js";

describe("notice prefs", () => {
  it("starts on the defaults with no overrides", () => {
    const s = new PrefsStore(new Database(":memory:"));
    expect(s.effective()).toEqual(DEFAULT_NOTICE_PREFS);
    expect(s.overrides()).toEqual({});
  });

  it("keeps only what differs from the default, so you follow future defaults", () => {
    const s = new PrefsStore(new Database(":memory:"));
    s.set({ chatDoneOs: false, apps: { a: "off", b: "mentions" } });
    expect(s.overrides()).toEqual({ chatDoneOs: false, apps: { a: "off" } });
    s.set({ chatDoneOs: true, apps: { a: "mentions" } });
    expect(s.overrides()).toEqual({});
  });

  it("drops junk instead of breaking routing", () => {
    expect(cleanPrefs({ priorityOs: "yes", chatDoneOs: false, apps: { x: "loud", y: "all" }, evil: 1 }))
      .toEqual({ chatDoneOs: false, apps: { y: "all" } });
  });
});
