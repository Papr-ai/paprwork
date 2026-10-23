import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import {
  evaluateDbChangeForTests,
  isLinkedJobSqliteFile,
  resolveJobIdForDbFileChange,
  registerWatchedDbPathForTests,
  resolveWatchedDbPathForTests,
} from "../src/gateway/services/TursoLinkedDbWatcher.js";
import * as tursoSyncBridgeCore from "../src/gateway/services/tursoSyncBridgeCore.js";
import * as tursoSyncState from "../src/gateway/services/tursoSyncState.js";

// Auto-upload is off in a fresh workspace; these tests cover the scheduler,
// not the upload preference.
vi.mock("../src/gateway/services/cloudUploadMode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/gateway/services/cloudUploadMode.js")>()),
  shouldAutoUploadJobFolder: vi.fn(() => true),
  shouldAutoUploadReplicaSyncKey: vi.fn(() => true),
  shouldAutoUploadTursoForApp: vi.fn(() => true),
}));


describe("TursoLinkedDbWatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const jobId = "job-abc";
  const dbPath = path.join("/Users/test/Papr/jobs", jobId, "data", "data.db");
  const dataDir = path.dirname(dbPath);

  it("recognizes main db and WAL/SHM sidecars", () => {
    expect(isLinkedJobSqliteFile(dbPath)).toBe(true);
    expect(isLinkedJobSqliteFile(`${dbPath}-wal`)).toBe(true);
    expect(isLinkedJobSqliteFile(`${dbPath}-shm`)).toBe(true);
    expect(isLinkedJobSqliteFile(path.join(dataDir, "other.db"))).toBe(false);
    expect(isLinkedJobSqliteFile(path.join(dataDir, "export.csv"))).toBe(false);
  });

  it("resolves job id from data.db, wal, and shm changes", () => {
    const dirToJobId = new Map([[dataDir, jobId]]);

    expect(resolveJobIdForDbFileChange(dbPath, dirToJobId)).toBe(jobId);
    expect(resolveJobIdForDbFileChange(`${dbPath}-wal`, dirToJobId)).toBe(jobId);
    expect(resolveJobIdForDbFileChange(`${dbPath}-shm`, dirToJobId)).toBe(jobId);
    expect(
      resolveJobIdForDbFileChange(path.join(dataDir, "notes.txt"), dirToJobId),
    ).toBeUndefined();
  });

  it("test helpers register data dir and match sqlite artifacts", () => {
    registerWatchedDbPathForTests(dbPath, jobId);

    expect(resolveWatchedDbPathForTests(dbPath)).toBe(dbPath);
    expect(resolveWatchedDbPathForTests(`${dbPath}-wal`)).toBe(`${dbPath}-wal`);
    expect(resolveWatchedDbPathForTests(`${dbPath}-shm`)).toBe(`${dbPath}-shm`);
    expect(resolveWatchedDbPathForTests(path.join(dataDir, "scratch.db"))).toBeNull();
  });

  it("quarantines corrupt databases instead of throwing during evaluation", async () => {
    const dbPath = path.join("/tmp/Papr/Jobs", jobId, "data", "data.db");
    const recordQuarantine = vi
      .spyOn(tursoSyncState, "recordTursoPushQuarantine")
      .mockImplementation(() => undefined);
    vi.spyOn(tursoSyncState, "isTursoStateDbPathInWorkspace").mockReturnValue(true);
    vi.spyOn(tursoSyncState, "loadTursoSyncState").mockReturnValue({ jobs: {} });
    vi.spyOn(tursoSyncState, "isJobDbQuarantined").mockReturnValue(false);
    vi.spyOn(tursoSyncBridgeCore, "ensureLocalDbChangeLogReady").mockImplementation(
      () => undefined,
    );
    vi.spyOn(tursoSyncBridgeCore, "localDbHasSyncableUserTables").mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });

    expect(() =>
      evaluateDbChangeForTests({ syncKey: jobId, dbPath, jobId }),
    ).not.toThrow();

    // Replica-vs-legacy routing resolves after async imports.
    await vi.waitFor(() =>
      expect(recordQuarantine).toHaveBeenCalledWith(
        jobId,
        dbPath,
        "database disk image is malformed",
      ),
    );
  });
});
