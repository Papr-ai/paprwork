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

import { isCollaboratorEditablePath } from "../src/gateway/services/CloudAppTrackSyncService.js";

describe("isCollaboratorEditablePath", () => {
  it("ignores files the platform rewrites", () => {
    for (const rel of [
      "backend/bundle.json",
      "papr-cloud-dependencies.json",
      "linked-databases.json",
      "metadata.json",
      "dist/app.js",
      "__papr__/app-meta.json",
    ]) {
      expect(isCollaboratorEditablePath(rel)).toBe(false);
    }
  });
  it("keeps real code", () => {
    for (const rel of ["app.ts", "styles.css", "README.md", "backend/ping.py"]) {
      expect(isCollaboratorEditablePath(rel)).toBe(true);
    }
  });
});
