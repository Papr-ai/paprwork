import { beforeEach, describe, expect, it, vi } from "vitest";
import { tursoReplicaBridgeMock } from "./helpers/tursoReplicaBridgeMock.js";
import { TursoSyncWorkerCrashError } from "../src/gateway/services/tursoReplica/tursoReplicaSyncWorkerProtocol.js";

const LOCAL_PATH = "/tmp/papr-isolated-sync/data.db";

function abortCrash(): TursoSyncWorkerCrashError {
  return new TursoSyncWorkerCrashError({
    op: "pull",
    localPath: LOCAL_PATH,
    exitCode: null,
    signal: "SIGABRT",
  });
}

async function loadWithMocks(runSync: ReturnType<typeof vi.fn>): Promise<{
  runIsolatedReplicaSync: typeof import("../src/gateway/services/tursoReplica/tursoReplicaIsolatedSync.js").runIsolatedReplicaSync;
  resetReplicaSidecars: ReturnType<typeof vi.fn>;
}> {
  const resetReplicaSidecars = vi.fn();

  vi.doMock(
    "../src/gateway/services/TursoSyncBridge.js",
    () => tursoReplicaBridgeMock(),
  );
  vi.doMock(
    "../src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.js",
    () => ({ getTursoReplicaSyncWorkerClient: () => ({ runSync }) }),
  );
  vi.doMock(
    "../src/gateway/services/tursoReplica/tursoReplicaSidecarWedge.js",
    () => ({ resetReplicaSidecars }),
  );

  const { runIsolatedReplicaSync } = await import(
    "../src/gateway/services/tursoReplica/tursoReplicaIsolatedSync.js"
  );
  return { runIsolatedReplicaSync, resetReplicaSidecars };
}

describe("runIsolatedReplicaSync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("resets sidecars and retries once after the worker aborts", async () => {
    const runSync = vi
      .fn()
      .mockRejectedValueOnce(abortCrash())
      .mockResolvedValueOnce(true);

    const { runIsolatedReplicaSync, resetReplicaSidecars } =
      await loadWithMocks(runSync);

    await expect(
      runIsolatedReplicaSync({
        op: "pull",
        localPath: LOCAL_PATH,
        tursoDatabase: "d-abc12345",
      }),
    ).resolves.toBe(true);

    // The replica caused an abort, so it must be reset before it is handed back to an engine.
    expect(resetReplicaSidecars).toHaveBeenCalledWith(LOCAL_PATH);
    expect(runSync).toHaveBeenCalledTimes(2);
  });

  it("leaves sidecars alone when sync merely returns an error", async () => {
    const runSync = vi
      .fn()
      .mockRejectedValue(new Error("remote rejected push: conflict"));

    const { runIsolatedReplicaSync, resetReplicaSidecars } =
      await loadWithMocks(runSync);

    await expect(
      runIsolatedReplicaSync({
        op: "push",
        localPath: LOCAL_PATH,
        tursoDatabase: "d-abc12345",
      }),
    ).rejects.toThrow("remote rejected push");

    // Resetting sidecars discards local WAL state — never do it for an ordinary failure.
    expect(resetReplicaSidecars).not.toHaveBeenCalled();
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it("stops after a second crash instead of looping", async () => {
    const runSync = vi.fn().mockRejectedValue(abortCrash());

    const { runIsolatedReplicaSync, resetReplicaSidecars } =
      await loadWithMocks(runSync);

    await expect(
      runIsolatedReplicaSync({
        op: "pull",
        localPath: LOCAL_PATH,
        tursoDatabase: "d-abc12345",
      }),
    ).rejects.toThrow(/crashed during pull/);

    expect(resetReplicaSidecars).toHaveBeenCalledTimes(1);
    expect(runSync).toHaveBeenCalledTimes(2);
  });
});
