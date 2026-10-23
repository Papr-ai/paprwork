import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { MAX_WEBVIEW_SESSIONS, pickSessionsToClose } = require("./webviewSessionCap.cjs") as {
  MAX_WEBVIEW_SESSIONS: number;
  pickSessionsToClose: (s: Array<{ id: string; createdAt: string }>, max?: number) => string[];
};

const at = (n: number) => `2026-10-20T18:0${n}:00.000Z`;

describe("pickSessionsToClose", () => {
  it("closes nothing while there is room for the new preview", () => {
    expect(pickSessionsToClose([])).toEqual([]);
    expect(pickSessionsToClose([{ id: "a", createdAt: at(1) }])).toEqual([]);
  });

  it("keeps room for the new session: max 3 means 2 stay open", () => {
    const open = [
      { id: "a", createdAt: at(1) },
      { id: "b", createdAt: at(2) },
      { id: "c", createdAt: at(3) },
    ];
    expect(MAX_WEBVIEW_SESSIONS).toBe(3);
    expect(pickSessionsToClose(open)).toEqual(["a"]);
  });

  it("closes the oldest first, however the list is ordered", () => {
    const open = [
      { id: "new", createdAt: at(8) },
      { id: "old", createdAt: at(1) },
      { id: "mid", createdAt: at(4) },
      { id: "newer", createdAt: at(9) },
      { id: "oldest", createdAt: at(0) },
    ];
    expect(pickSessionsToClose(open)).toEqual(["oldest", "old", "mid"]);
  });

  it("recovers from a pile-up of forgotten previews in one launch", () => {
    const open = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, createdAt: at(i) }));
    expect(pickSessionsToClose(open)).toHaveLength(7 - 1);
  });
});
