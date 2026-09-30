import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("tursoCredentialsStore", () => {
  const paprDir = path.join(os.tmpdir(), `turso-creds-test-${process.pid}`);

  afterEach(() => {
    fs.rmSync(paprDir, { recursive: true, force: true });
  });

  it("round-trips credentials per database", async () => {
    const {
      saveTursoCredentialsEntry,
      getTursoCredentialsEntry,
      clearTursoCredentialsStore,
    } = await import("../src/gateway/services/tursoCredentialsStore.js");

    const expiresAtMs = Date.now() + 3_600_000;
    saveTursoCredentialsEntry(
      "db-sqa",
      { tursoUrl: "libsql://sqa.turso.io", authToken: "tok-abc" },
      expiresAtMs,
      paprDir,
    );

    const loaded = getTursoCredentialsEntry("db-sqa", paprDir);
    expect(loaded?.tursoUrl).toBe("libsql://sqa.turso.io");
    expect(loaded?.authToken).toBe("tok-abc");
    expect(loaded?.expiresAtMs).toBe(expiresAtMs);

    clearTursoCredentialsStore(paprDir);
    expect(getTursoCredentialsEntry("db-sqa", paprDir)).toBeNull();
  });
});

describe("TursoSyncBridge offline credentials", () => {
  useIsolatedPaprWorkspace("turso-credentials-offline");

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolveCredentialsForReplicaOpen uses persisted creds when refresh fails", async () => {
    vi.doMock("../src/gateway/utils/keyResolver.js", () => ({
      getPaprApiKey: vi.fn(async () => {
        throw new Error("offline");
      }),
    }));

    const { saveTursoCredentialsEntry } = await import(
      "../src/gateway/services/tursoCredentialsStore.js"
    );
    saveTursoCredentialsEntry(
      "db-offline",
      { tursoUrl: "libsql://offline.turso.io", authToken: "stale-tok" },
      Date.now() - 60_000,
    );

    const { initializeTursoSyncBridge } = await import(
      "../src/gateway/services/TursoSyncBridge.js"
    );
    const bridge = initializeTursoSyncBridge({ enabled: true });

    const creds = await bridge.resolveCredentialsForReplicaOpen("db-offline", {
      localReplicaExists: true,
    });

    expect(creds.tursoUrl).toBe("libsql://offline.turso.io");
    expect(creds.authToken).toBe("stale-tok");
  });

  it("fetchCredentials persists server expiresAt", async () => {
    vi.doMock("../src/gateway/utils/keyResolver.js", () => ({
      getPaprApiKey: vi.fn(async () => "sk-test"),
    }));

    const expiresAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tursoUrl: "libsql://fresh.turso.io",
          authToken: "fresh-tok",
          expiresAt,
        }),
      })),
    );

    const { initializeTursoSyncBridge } = await import(
      "../src/gateway/services/TursoSyncBridge.js"
    );
    const { getTursoCredentialsEntry } = await import(
      "../src/gateway/services/tursoCredentialsStore.js"
    );

    const bridge = initializeTursoSyncBridge({ enabled: true });
    const creds = await bridge.fetchCredentials("db-fresh");

    expect(creds.authToken).toBe("fresh-tok");
    const persisted = getTursoCredentialsEntry("db-fresh");
    expect(persisted?.authToken).toBe("fresh-tok");
    expect(persisted?.expiresAtMs).toBeGreaterThan(Date.now());
  });
});
