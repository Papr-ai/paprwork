import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "../../setup/isolatedWorkspace.js";

const ORG_A = "orgAAAAAAAA";
const NS_A = "nsAAAAAAAAA";
const ORG_B = "orgBBBBBBBB";
const NS_B = "nsBBBBBBBBB";
const USER_1 = "user1111111";
const USER_2 = "user2222222";

function setIdentity(org: string, ns: string, user: string): void {
  process.env.PAPR_ORG_ID = org;
  process.env.PAPR_NAMESPACE_ID = ns;
  process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = user;
}

function key(org: string, ns: string, user: string, db: string): string {
  return `${org}/${ns}/${user}/${db}`;
}

function stubTokenServer(
  respond: (db: string, call: number) => { tursoUrl: string; authToken: string },
  opts?: { delayMs?: number },
) {
  let calls = 0;
  const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { database: string };
    calls += 1;
    const n = calls;
    if (opts?.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    return {
      ok: true,
      json: async () => ({
        ...respond(body.database, n),
        expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("tursoCredentialsStore", () => {
  const paprDir = path.join(os.tmpdir(), `turso-creds-test-${process.pid}`);

  afterEach(() => {
    fs.rmSync(paprDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("round-trips credentials per scoped key", async () => {
    const {
      saveTursoCredentialsEntry,
      getTursoCredentialsEntry,
      clearTursoCredentialsStore,
    } = await import("../../../src/gateway/services/tursoCredentialsStore.js");

    const expiresAtMs = Date.now() + 3_600_000;
    const k = key(ORG_A, NS_A, USER_1, "db-sqa");
    saveTursoCredentialsEntry(
      k,
      { tursoUrl: "libsql://sqa.turso.io", authToken: "tok-abc" },
      expiresAtMs,
      paprDir,
    );

    const loaded = getTursoCredentialsEntry(k, paprDir);
    expect(loaded?.tursoUrl).toBe("libsql://sqa.turso.io");
    expect(loaded?.authToken).toBe("tok-abc");
    expect(loaded?.expiresAtMs).toBe(expiresAtMs);

    clearTursoCredentialsStore(paprDir);
    expect(getTursoCredentialsEntry(k, paprDir)).toBeNull();
  });

  it("scope key fails closed when any identity part is missing", async () => {
    const { tursoCredentialsScopeKey } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    expect(tursoCredentialsScopeKey(null, "sync-index")).toBeNull();
    expect(
      tursoCredentialsScopeKey(
        { organizationId: ORG_A, namespaceId: NS_A, userId: "" },
        "sync-index",
      ),
    ).toBeNull();
    expect(
      tursoCredentialsScopeKey(
        { organizationId: ORG_A, namespaceId: NS_A, userId: USER_1 },
        "sync-index",
      ),
    ).toBe(key(ORG_A, NS_A, USER_1, "sync-index"));
  });

  it("never returns legacy unscoped entries and prunes them on next save", async () => {
    const {
      saveTursoCredentialsStore,
      saveTursoCredentialsEntry,
      getTursoCredentialsEntry,
      loadTursoCredentialsStore,
    } = await import("../../../src/gateway/services/tursoCredentialsStore.js");

    saveTursoCredentialsStore(
      {
        databases: {
          "sync-index": {
            tursoUrl: "libsql://legacy.turso.io",
            authToken: "legacy",
            expiresAtMs: Date.now() + 3_600_000,
            updatedAt: new Date().toISOString(),
          },
        },
      },
      paprDir,
    );
    expect(getTursoCredentialsEntry("sync-index", paprDir)).toBeNull();

    saveTursoCredentialsEntry(
      key(ORG_A, NS_A, USER_1, "d-1"),
      { tursoUrl: "libsql://d1", authToken: "t" },
      Date.now() + 3_600_000,
      paprDir,
    );
    expect(Object.keys(loadTursoCredentialsStore(paprDir).databases)).toEqual([
      key(ORG_A, NS_A, USER_1, "d-1"),
    ]);
  });
});

describe("TursoSyncBridge credentials", () => {
  useIsolatedPaprWorkspace("turso-credentials-offline");

  const savedEnv = {
    org: process.env.PAPR_ORG_ID,
    ns: process.env.PAPR_NAMESPACE_ID,
    user: process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID,
  };

  beforeEach(() => {
    setIdentity(ORG_A, NS_A, USER_1);
    vi.doMock("../../../src/gateway/utils/keyResolver.js", () => ({
      getPaprApiKey: vi.fn(async () => "sk-test"),
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../../src/gateway/utils/paprUserId.js");
    vi.doUnmock("../../../src/gateway/utils/keyResolver.js");
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    for (const [envKey, value] of [
      ["PAPR_ORG_ID", savedEnv.org],
      ["PAPR_NAMESPACE_ID", savedEnv.ns],
      ["PAPRWORK_TELEMETRY_PAPR_USER_ID", savedEnv.user],
    ] as const) {
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  });

  async function freshBridge() {
    const { initializeTursoSyncBridge } = await import(
      "../../../src/gateway/services/TursoSyncBridge.js"
    );
    return initializeTursoSyncBridge({ enabled: true });
  }

  it("resolveCredentialsForReplicaOpen uses persisted creds when refresh fails", async () => {
    vi.doMock("../../../src/gateway/utils/keyResolver.js", () => ({
      getPaprApiKey: vi.fn(async () => {
        throw new Error("offline");
      }),
    }));

    const { saveTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    saveTursoCredentialsEntry(
      key(ORG_A, NS_A, USER_1, "db-offline"),
      { tursoUrl: "libsql://offline.turso.io", authToken: "stale-tok" },
      Date.now() - 60_000,
    );

    const bridge = await freshBridge();
    const creds = await bridge.resolveCredentialsForReplicaOpen("db-offline", {
      localReplicaExists: true,
    });

    expect(creds.tursoUrl).toBe("libsql://offline.turso.io");
    expect(creds.authToken).toBe("stale-tok");
  });

  it("fetchCredentials persists server expiresAt under the requester's scope", async () => {
    stubTokenServer(() => ({ tursoUrl: "libsql://fresh.turso.io", authToken: "fresh-tok" }));

    const bridge = await freshBridge();
    const { getTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    const creds = await bridge.fetchCredentials("db-fresh");

    expect(creds.authToken).toBe("fresh-tok");
    const persisted = getTursoCredentialsEntry(key(ORG_A, NS_A, USER_1, "db-fresh"));
    expect(persisted?.authToken).toBe("fresh-tok");
    expect(persisted?.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("cached token survives a gateway restart (no refetch)", async () => {
    const fetchMock = stubTokenServer(() => ({ tursoUrl: "libsql://a", authToken: "tok-a" }));
    await (await freshBridge()).fetchCredentials("d-app");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const restarted = await freshBridge();
    const creds = await restarted.fetchCredentials("d-app");
    expect(creds.authToken).toBe("tok-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("same short name in another workspace never reuses the first workspace's token", async () => {
    const fetchMock = stubTokenServer((_db, n) => ({
      tursoUrl: `libsql://sync-index-${n}`,
      authToken: `tok-${n}`,
    }));
    const bridge = await freshBridge();

    const a = await bridge.fetchCredentials("sync-index");
    setIdentity(ORG_B, NS_B, USER_1);
    const b = await bridge.fetchCredentials("sync-index");

    expect(a.authToken).toBe("tok-1");
    expect(b.authToken).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Switching back is instant — A's token is still there.
    setIdentity(ORG_A, NS_A, USER_1);
    expect((await bridge.fetchCredentials("sync-index")).authToken).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a different user in the same workspace does not reuse another user's token", async () => {
    const fetchMock = stubTokenServer((_db, n) => ({ tursoUrl: `libsql://x${n}`, authToken: `tok-${n}` }));
    const bridge = await freshBridge();

    await bridge.fetchCredentials("d-shared");
    setIdentity(ORG_A, NS_A, USER_2);
    const second = await bridge.fetchCredentials("d-shared");

    expect(second.authToken).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a fetch that resolves after a workspace switch is filed under the original workspace", async () => {
    stubTokenServer(() => ({ tursoUrl: "libsql://ws-a", authToken: "tok-from-a" }), {
      delayMs: 30,
    });
    const bridge = await freshBridge();
    const { getTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );

    const pending = bridge.fetchCredentials("sync-index");
    setIdentity(ORG_B, NS_B, USER_1); // switch while the request is in flight
    await pending;

    expect(getTursoCredentialsEntry(key(ORG_A, NS_A, USER_1, "sync-index"))?.authToken).toBe(
      "tok-from-a",
    );
    expect(getTursoCredentialsEntry(key(ORG_B, NS_B, USER_1, "sync-index"))).toBeNull();
  });

  it("no identity → no caching (fails closed)", async () => {
    delete process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
    vi.doMock("../../../src/gateway/utils/paprUserId.js", async (orig) => ({
      ...(await orig<object>()),
      getPaprUserId: () => undefined,
    }));
    const fetchMock = stubTokenServer(() => ({ tursoUrl: "libsql://n", authToken: "tok" }));
    const bridge = await freshBridge();
    const { loadTursoCredentialsStore } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );

    await bridge.fetchCredentials("d-x");
    await bridge.fetchCredentials("d-x");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(loadTursoCredentialsStore().databases)).toHaveLength(0);
  });

  it("shared DB: stores the publisher URL the server returned, untouched, and reuses it after restart", async () => {
    const publisherUrl = "libsql://p-pubOrg0-pubNs00-publishr-d-team1234-acme.turso.io";
    const fetchMock = stubTokenServer(() => ({ tursoUrl: publisherUrl, authToken: "pub-tok" }));
    await (await freshBridge()).fetchCredentials("d-team1234", { appId: "app-1" });

    vi.resetModules();
    const creds = await (await freshBridge()).fetchCredentials("d-team1234", { appId: "app-1" });
    expect(creds.tursoUrl).toBe(publisherUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidateCredentialsCache() without a name keeps the persisted store", async () => {
    const fetchMock = stubTokenServer(() => ({ tursoUrl: "libsql://k", authToken: "keep" }));
    const bridge = await freshBridge();
    await bridge.fetchCredentials("d-keep");

    bridge.invalidateCredentialsCache();
    expect((await bridge.fetchCredentials("d-keep")).authToken).toBe("keep");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("auth error drops only that database's token", async () => {
    const fetchMock = stubTokenServer((db, n) => ({ tursoUrl: `libsql://${db}`, authToken: `${db}-${n}` }));
    const bridge = await freshBridge();
    await bridge.fetchCredentials("d-bad");
    await bridge.fetchCredentials("d-good");

    expect(bridge.invalidateCredentialsOnAuthError("d-bad", new Error("HTTP 401 Unauthorized"))).toBe(true);
    expect(bridge.invalidateCredentialsOnAuthError("d-good", new Error("fetch failed"))).toBe(false);

    expect((await bridge.fetchCredentials("d-good")).authToken).toBe("d-good-2");
    expect((await bridge.fetchCredentials("d-bad")).authToken).toBe("d-bad-3");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
