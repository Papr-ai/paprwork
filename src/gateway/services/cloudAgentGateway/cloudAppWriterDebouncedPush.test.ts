import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const finalize = vi.fn();
vi.mock("../syncV3/finalizeAppRepoMutation.js", () => ({
  finalizeAppRepoMutation: (...args: unknown[]) => finalize(...args),
}));
vi.mock("../cloudAppMetadataFile.js", () => ({
  writeCloudAppMetadataFile: async () => undefined,
}));
vi.mock("../../../core/utils/paprRoot.js", () => ({ getPaprRoot: () => "/tmp/papr" }));

const mod = await import("./cloudAppWriterDebouncedPush.js");

describe("cloud sandbox app writer", () => {
  beforeEach(() => {
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.CLOUD_AGENT_WRITER_DEBOUNCE_MS = "60000";
    finalize.mockReset();
    finalize.mockResolvedValue({ writerPushed: true, commitSha: "abc12345", deferred: 0 });
  });
  afterEach(() => {
    delete process.env.GATEWAY_MODE;
  });

  it("an edit during a run is pushed when the run finishes", async () => {
    const handle = await mod.startCloudAppWriterDebouncedPush();
    mod.notifyCloudSandboxAppSave("app-1");
    const result = await handle.flushAndStop();
    expect(finalize).toHaveBeenCalledWith("/tmp/papr", "app-1", expect.anything());
    expect(result.pushedAppIds).toEqual(["app-1"]);
  });

  it("push_cloud_sync in a cloud run publishes the app now", async () => {
    const handle = await mod.startCloudAppWriterDebouncedPush();
    await expect(mod.flushCloudSandboxAppNow("app-2")).resolves.toEqual({ pushed: true });
    expect(finalize).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("refuses to publish for callers who can't change the live app", async () => {
    mod.disableCloudAppWriterForRun("contributor");
    const out = await mod.flushCloudSandboxAppNow("app-3");
    expect(out.pushed).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
  });
});
