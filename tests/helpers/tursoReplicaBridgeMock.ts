import { vi } from "vitest";

/** Bridge mock matching TursoReplicaService.openConnection (ensureTursoSyncBridge). */
export function tursoReplicaBridgeMock(): {
  ensureTursoSyncBridge: ReturnType<typeof vi.fn>;
  getTursoSyncBridge: ReturnType<typeof vi.fn>;
} {
  const bridge = {
    enabled: true,
    fetchCredentials: vi.fn(async () => ({
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    })),
    resolveCredentialsForReplicaOpen: vi.fn(async () => ({
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    })),
  };
  return {
    ensureTursoSyncBridge: vi.fn(() => bridge),
    getTursoSyncBridge: vi.fn(() => bridge),
  };
}

export const CHECKPOINT_WAL_ERROR =
  "sync engine operation failed: database sync engine error: unable to checkpoint synced portion of wal: result=CheckpointResult { wal_max_frame: 0";
