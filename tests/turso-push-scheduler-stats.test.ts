import { describe, expect, it, vi, beforeEach } from "vitest";

const bridgeMock = vi.hoisted(() => ({
  enabled: true,
  isJobLinkedToApp: vi.fn(async () => true),
  listLinkedSources: vi.fn(async () => [
    {
      appId: "app-1",
      jobId: "job-1",
      dbPath: "/tmp/job/data.db",
      alias: "main",
      role: "primary" as const,
    },
  ]),
  linkedSourceNeedsPush: vi.fn(async () => true),
  pushJob: vi.fn(async () => ({
    status: "pushed" as const,
    tables: ["items"],
    syncMode: "delta" as const,
  })),
}));

vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({
  getTursoSyncBridge: () => bridgeMock,
}));

// Spread the real module instead of listing exports by hand — the two-export
// version broke as soon as the scheduler reached loadTursoSyncState, with an
// error naming the mock rather than the missing export.
vi.mock("../src/gateway/services/tursoSyncState.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/gateway/services/tursoSyncState.js")
  >()),
  recordTursoPushSuccess: vi.fn(),
  recordTursoPushQuarantine: vi.fn(),
}));

import {
  getTursoPushSchedulerStatsForTests,
  resetTursoPushQueueForTests,
  scheduleTursoPushForJob,
} from "../src/gateway/services/tursoPushScheduler.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("tursoPushScheduler stats", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("turso-push-scheduler-stats");

  beforeEach(() => {
    vi.clearAllMocks();
    resetTursoPushQueueForTests();
    process.env.TURSO_PUSH_DEBOUNCE_MS = "5000";
  });

  it(
    "coalesces duplicate schedules into one enqueue per debounce window",
    async () => {
      scheduleTursoPushForJob("job-1", "normal", "watcher");
      scheduleTursoPushForJob("job-1", "normal", "watcher");
      scheduleTursoPushForJob("job-1", "normal", "watcher");

      const stats = getTursoPushSchedulerStatsForTests();
      expect(stats.schedules).toBe(3);
      expect(stats.enqueues).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 5100));

      const after = getTursoPushSchedulerStatsForTests();
      expect(after.enqueues).toBe(1);
      expect(after.enqueuesByKey["job-1"]).toBe(1);
      expect(bridgeMock.pushJob).toHaveBeenCalledTimes(1);
    },
    10_000,
  );
});
