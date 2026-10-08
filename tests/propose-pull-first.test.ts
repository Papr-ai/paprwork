import { describe, expect, it, vi } from "vitest";
import { pullPublisherBeforePropose } from "../src/gateway/services/cloudSync/proposePullFirst.js";

function deps(opts: { updates: boolean; conflictFiles?: string[] }) {
  const syncTrackApp = vi.fn(async () => ({
    conflictFiles: opts.conflictFiles ?? [],
    updatedFiles: ["app.ts"],
    mergedFiles: [],
  }));
  return {
    checkUpstream: vi.fn(async () => ({ publisherUpdatesAvailable: opts.updates })),
    syncTrackApp,
  };
}

describe("pullPublisherBeforePropose", () => {
  it("does not pull when the copy is already up to date", async () => {
    const d = deps({ updates: false });
    expect(await pullPublisherBeforePropose("app-1", d)).toBeNull();
    expect(d.syncTrackApp).not.toHaveBeenCalled();
  });

  it("pulls the publisher's latest and lets the proposal go ahead when nothing overlaps", async () => {
    const d = deps({ updates: true });
    expect(await pullPublisherBeforePropose("app-1", d)).toBeNull();
    expect(d.syncTrackApp).toHaveBeenCalledWith("app-1");
  });

  it("stops the proposal and returns the overlapping files", async () => {
    const d = deps({ updates: true, conflictFiles: ["index.html"] });
    expect(await pullPublisherBeforePropose("app-1", d)).toEqual({
      conflictFiles: ["index.html"],
      updatedFiles: ["app.ts"],
      mergedFiles: [],
    });
  });
});
