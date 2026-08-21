import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { finalizeAppRepoMutation } = vi.hoisted(() => ({
  finalizeAppRepoMutation: vi.fn(),
}));

const { getPaprRoot } = vi.hoisted(() => ({
  getPaprRoot: vi.fn(() => "/tmp/papr-cloud-writer-test"),
}));

vi.mock("../src/gateway/services/syncV3/finalizeAppRepoMutation.js", () => ({
  finalizeAppRepoMutation,
}));

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprRoot,
}));

import {
  notifyCloudSandboxAppSave,
  resetCloudAppWriterDebouncedPushForTests,
  startCloudAppWriterDebouncedPush,
} from "../src/gateway/services/cloudAgentGateway/cloudAppWriterDebouncedPush.js";

describe("cloud app writer debounced push", () => {
  const previousGatewayMode = process.env.GATEWAY_MODE;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.CLOUD_AGENT_WRITER_DEBOUNCE_MS = "5000";
    process.env.CLOUD_AGENT_WRITER_MAX_WAIT_MS = "30000";
    resetCloudAppWriterDebouncedPushForTests();
    finalizeAppRepoMutation.mockReset();
    finalizeAppRepoMutation.mockResolvedValue({
      appId: "app-1",
      writerPushed: true,
      catalogSynced: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCloudAppWriterDebouncedPushForTests();
    if (previousGatewayMode === undefined) {
      delete process.env.GATEWAY_MODE;
    } else {
      process.env.GATEWAY_MODE = previousGatewayMode;
    }
    delete process.env.CLOUD_AGENT_WRITER_DEBOUNCE_MS;
    delete process.env.CLOUD_AGENT_WRITER_MAX_WAIT_MS;
  });

  it("ignores saves outside cloud_agent mode", async () => {
    process.env.GATEWAY_MODE = "desktop";
    notifyCloudSandboxAppSave("app-1");
    await vi.advanceTimersByTimeAsync(6000);
    expect(finalizeAppRepoMutation).not.toHaveBeenCalled();
  });

  it("debounces writer finalize after sandbox app save", async () => {
    await startCloudAppWriterDebouncedPush();
    notifyCloudSandboxAppSave("app-1");
    expect(finalizeAppRepoMutation).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(finalizeAppRepoMutation).toHaveBeenCalledWith(
      "/tmp/papr-cloud-writer-test",
      "app-1",
      expect.objectContaining({ source: "cloud-sandbox", skipCatalog: true }),
    );
  });

  it("flushAndStop drains saves that arrive during flush", async () => {
    const handle = await startCloudAppWriterDebouncedPush();
    notifyCloudSandboxAppSave("app-1");

    finalizeAppRepoMutation.mockImplementation(async (_paprDir, appId) => {
      if (appId === "app-1") {
        notifyCloudSandboxAppSave("app-2");
      }
      return { appId, writerPushed: true, catalogSynced: false };
    });

    const result = await handle.flushAndStop();
    expect(result.pushedAppIds.sort()).toEqual(["app-1", "app-2"]);
    expect(finalizeAppRepoMutation).toHaveBeenCalledTimes(2);
  });

  it("re-queues apps when writer flush fails", async () => {
    const handle = await startCloudAppWriterDebouncedPush();
    notifyCloudSandboxAppSave("app-fail");

    finalizeAppRepoMutation.mockRejectedValueOnce(new Error("writer 503"));
    finalizeAppRepoMutation.mockResolvedValueOnce({
      appId: "app-fail",
      writerPushed: true,
      catalogSynced: false,
    });

    const first = await handle.flush();
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]?.appId).toBe("app-fail");

    const second = await handle.flush();
    expect(second.pushedAppIds).toEqual(["app-fail"]);
    expect(finalizeAppRepoMutation).toHaveBeenCalledTimes(2);
  });

  it("awaits in-flight flush when drain returns empty app list", async () => {
    const handle = await startCloudAppWriterDebouncedPush();
    notifyCloudSandboxAppSave("app-1");

    let resolveFlush: ((value: unknown) => void) | undefined;
    finalizeAppRepoMutation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFlush = resolve;
        }),
    );

    const inFlight = handle.flush();
    await vi.advanceTimersByTimeAsync(0);

    const emptyDrain = handle.flush();
    resolveFlush?.({
      appId: "app-1",
      writerPushed: true,
      catalogSynced: false,
    });

    const [first, second] = await Promise.all([inFlight, emptyDrain]);
    expect(first.pushedAppIds).toEqual(["app-1"]);
    expect(second.pushedAppIds).toEqual(["app-1"]);
  });
});
