import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseDiagnosticCollector } from "../src/gateway/services/databaseDiagnostics/collector.js";
import { stopDatabaseDiagnosticTransport } from "../src/gateway/services/databaseDiagnostics/trace.js";
import { TursoSyncWorkerCore } from "../src/gateway/services/tursoReplica/tursoReplicaSyncWorkerCore.js";

const fake = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../src/gateway/services/tursoReplica/tursoReplicaConnect.js", () => ({ connectTursoReplica: fake.connect }));
afterEach(() => { stopDatabaseDiagnosticTransport(); vi.unstubAllEnvs(); });

test("Turso reports actual executing operations on a stable handle and leaves internal transaction ownership unknown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdt-"));
  const endpoint = process.platform === "win32" ? String.raw`\\.\pipe` + "\\" + path.basename(dir) : path.join(dir, "t.sock");
  const collector = new DatabaseDiagnosticCollector(); await collector.listen(endpoint);
  vi.stubEnv("PAPR_DB_DIAGNOSTICS_SOCKET", endpoint);
  vi.stubEnv("PAPR_DATABASE_DIAGNOSTICS", "1");
  let release!: (value: boolean) => void;
  fake.connect.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined),
    pull: () => new Promise<boolean>(resolve => { release = resolve; }),
    prepare: async () => ({ all: async () => [{ privateData: "never-export" }] }),
    exec: async () => { throw Object.assign(new Error("private engine error"), { code: "SQLITE_BUSY" }); },
  });
  const core = new TursoSyncWorkerCore();
  const spec = { localPath: path.join(dir, "data.db"), tursoUrl: "https://private-endpoint", authToken: "secret-auth-token", bootstrapIfEmpty: false };
  try {
    await core.run({ ...spec, id: "open", op: "connect" });
    await vi.waitFor(() => expect(collector.snapshot().connections).toHaveLength(1));
    const id = collector.snapshot().connections[0].connectionId;
    const pulling = core.run({ ...spec, id: "pull", op: "pull" });
    await vi.waitFor(() => expect(collector.snapshot().connections[0].operations[0]?.kind).toBe("pull"));
    expect(collector.snapshot().connections[0].transaction.state).toBe("unknown");
    release(true); await pulling;
    const result = await core.run({ ...spec, id: "query", op: "query", sql: "SELECT privateData FROM privateTable", params: ["private-parameter"] });
    expect(result.result).toEqual({ rows: [{ privateData: "never-export" }] });
    await vi.waitFor(() => expect(collector.snapshot().connections[0].operations).toHaveLength(0));
    expect(collector.snapshot().connections[0].connectionId).toBe(id);
    await expect(core.run({ ...spec, id: "error", op: "exec", sql: "private SQL" })).rejects.toThrow("private engine error");
    await vi.waitFor(() => expect(collector.snapshot().recent.some(r => r.errorCode === "SQLITE_BUSY")).toBe(true));
    await vi.waitFor(() => expect(collector.snapshot().connections).toHaveLength(0));
    const exported = JSON.stringify(collector.snapshot());
    for (const secret of ["private-endpoint", "secret-auth-token", "privateTable", "private-parameter", "private engine error", "never-export"]) expect(exported).not.toContain(secret);
  } finally {
    await core.closeAll(); stopDatabaseDiagnosticTransport(); await collector.close(); await rm(dir, { recursive: true, force: true });
  }
});
