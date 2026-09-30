import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const changeHandlers: Array<(path: string) => void> = [];

const { pushLinkedSourceToCloud } = vi.hoisted(() => ({
  pushLinkedSourceToCloud: vi.fn(),
}));

vi.mock("../src/gateway/services/TreeWatcher.js", () => ({
  TreeWatcher: vi.fn().mockImplementation((options: { onEvent: (e: { type: string; path: string; root: string }) => void }) => {
    changeHandlers.push((p: string) =>
      options.onEvent({ type: "change", path: p, root: p.replace(/\/[^/]+$/, "") }),
    );
    return {
      rootCount: 1,
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock(
  "../src/gateway/services/cloudAgentGateway/syncJobTursoBookends.js",
  () => ({
    pushLinkedSourceToCloud,
  }),
);

vi.mock("../src/gateway/services/tursoSyncBridgeCore.js", () => ({
  ensureLocalDbChangeLogReady: vi.fn(),
}));

import {
  isCloudTursoSqliteFile,
  startCloudAgentTursoDebouncedPush,
} from "../src/gateway/services/cloudAgentGateway/cloudAgentTursoDebouncedPush.js";

describe("cloud agent Turso debounced push", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    changeHandlers.length = 0;
    pushLinkedSourceToCloud.mockReset();
    pushLinkedSourceToCloud.mockResolvedValue({
      status: "pushed",
      tables: ["audits"],
      syncMode: "delta",
    });
    process.env.CLOUD_AGENT_TURSO_DEBOUNCE_MS = "5000";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLOUD_AGENT_TURSO_DEBOUNCE_MS;
  });

  it("detects sqlite artifacts including WAL sidecars", () => {
    expect(isCloudTursoSqliteFile("/tmp/data/data.db")).toBe(true);
    expect(isCloudTursoSqliteFile("/tmp/data/data.db-wal")).toBe(true);
    expect(isCloudTursoSqliteFile("/tmp/data/data.db-shm")).toBe(true);
    expect(isCloudTursoSqliteFile("/tmp/data/readme.txt")).toBe(false);
  });

  it("debounces push after sandbox sqlite change", async () => {
    const target = {
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data/databases/gtm-audit/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    };

    const handle = await startCloudAgentTursoDebouncedPush([target]);
    expect(handle).toBeDefined();

    for (const handler of changeHandlers) {
      handler("/tmp/sandbox/data/databases/gtm-audit/data.db-wal");
    }

    expect(pushLinkedSourceToCloud).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(pushLinkedSourceToCloud).toHaveBeenCalledOnce();
    expect(pushLinkedSourceToCloud).toHaveBeenCalledWith(target);

    await handle!.stop();
    await handle!.flush();
  });

  it("flush pushes immediately without waiting for debounce", async () => {
    const target = {
      syncKey: "db-xyz",
      dbPath: "/tmp/sandbox/Jobs/job-1/data/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    };

    const handle = await startCloudAgentTursoDebouncedPush([target]);
    for (const handler of changeHandlers) {
      handler("/tmp/sandbox/Jobs/job-1/data/data.db");
    }

    await handle!.stop();
    await handle!.flush();

    expect(pushLinkedSourceToCloud).toHaveBeenCalledWith(target);
  });
});
