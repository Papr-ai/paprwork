import { describe, expect, it } from "vitest";
import { listLocalEditsAgainstSnapshot } from "../src/gateway/services/CloudAppTrackSyncService.js";

describe("listLocalEditsAgainstSnapshot", () => {
  it("is empty when local matches the last upstream sync", () => {
    expect(
      listLocalEditsAgainstSnapshot(new Map([["app.ts", "a"], ["index.html", "b"]]), { "app.ts": "a", "index.html": "b" }),
    ).toEqual([]);
  });
  it("lists changed, added and deleted files", () => {
    expect(
      listLocalEditsAgainstSnapshot(new Map([["app.ts", "CHANGED"], ["new.ts", "n"]]), { "app.ts": "a", "gone.ts": "g" }),
    ).toEqual(["app.ts", "gone.ts", "new.ts"]);
  });
});
