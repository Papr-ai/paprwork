import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/services/syncV3/SyncOidCache.js", async (orig) => ({
  ...(await orig<object>()),
  invalidateCachedPath: vi.fn(async () => {}),
}));

import {
  clearWriterConflictsForApp,
  clearWriterConflictsForTests,
  invalidateWriterConflictPaths,
  listRecentWriterConflicts,
} from "../src/gateway/services/syncV3/writerConflict.js";

describe("stale 'Conflict on the web' is cleared once resolved", () => {
  beforeEach(() => clearWriterConflictsForTests());

  it("clearing one app leaves other apps' conflicts", async () => {
    const art = [{ path: "index.html", expectedParentHash: "a", actualBlobOid: "b" }] as never;
    await invalidateWriterConflictPaths("app-1", art);
    await invalidateWriterConflictPaths("app-2", art);
    expect(clearWriterConflictsForApp("app-1")).toBe(1);
    expect(listRecentWriterConflicts("app-1")).toHaveLength(0);
    expect(listRecentWriterConflicts("app-2")).toHaveLength(1);
  });
});
