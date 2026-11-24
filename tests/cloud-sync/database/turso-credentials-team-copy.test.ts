/**
 * Repro (Launch Post Studio, 2026-11-23): a teammate's copy on the team's data
 * read an EMPTY database. Two desktop causes:
 *
 *  1. Token requests sent the local copy's app id; the server only knows the
 *     publisher's app id, so it minted a token for an own-segment copy.
 *  2. That 2-week token was cached under org/ns/user/db only and survived
 *     uninstall + reinstall, so the fresh copy kept reading the empty DB.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "../../setup/isolatedWorkspace.js";

const ORG = "Y8D4H7Yp3Z";
const NS = "85ZIB7mD1V";
const ME = "mKCnhHg5xyz"; // collaborator (Shawkat)
const PUB = "WkPutXGdqg"; // publisher (Amir)
const DB_ID = "83320841-aaaa-bbbb-cccc-000000000001";
const DB = "d-83320841";
const LOCAL_APP = "0c56fd0e-0000-4000-8000-000000000001";
const SOURCE_APP = "9409ec58-c544-48d1-9b98-83fe922511ae";
const PUB_URL = "libsql://p-y8d4h7yp-85zib7md-wkputxgd-d-83320841-org.turso.io";
const OWN_URL = "libsql://p-y8d4h7yp-85zib7md-mkcnhhg5-d-83320841-org.turso.io";
const key = `${ORG}/${NS}/${ME}/${DB}`;

describe("Turso tokens for a copy on team data", () => {
  const ws = useIsolatedPaprWorkspace("turso-credentials-team-copy");
  let requests: Array<{ database: string; appId?: string }>;

  beforeEach(async () => {
    process.env.PAPR_ORG_ID = ORG;
    process.env.PAPR_NAMESPACE_ID = NS;
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = ME;
    vi.doMock("../../../src/gateway/utils/keyResolver.js", () => ({
      getPaprApiKey: vi.fn(async () => "sk-test"),
    }));
    requests = [];
    // Server behaviour before the memory fix: a scoped request matches only
    // the publisher's app id; anything else lands on the caller's own copy.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (!String(url).includes("/v1/cloud/databases/token")) {
          return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { database: string; appId?: string };
        requests.push({ database: body.database, appId: body.appId });
        const shared = body.appId === SOURCE_APP;
        return {
          ok: true,
          json: async () => ({
            tursoUrl: shared ? PUB_URL : OWN_URL,
            authToken: shared ? "pub-tok" : "own-tok",
            expiresAt: new Date(Date.now() + (shared ? 1 : 14) * 86_400_000).toISOString(),
          }),
        };
      }),
    );

    const appDir = path.join(ws.paprHome, "apps", LOCAL_APP);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "papr-cloud-lineage.json"),
      JSON.stringify({
        schemaVersion: "1.2.0",
        lineageId: "l-1",
        mode: "track",
        databasePolicy: "shared",
        installedAt: new Date().toISOString(),
        source: { orgId: ORG, namespaceId: NS, userId: PUB, appId: SOURCE_APP, slug: "launch-post-studio" },
      }),
    );
    await fs.writeFile(
      path.join(appDir, "data-sources.json"),
      JSON.stringify({ sources: [{ type: "sqlite", alias: "posts", dbId: DB_ID, dbPath: "x.db" }] }),
    );
    const { initializeDatabaseRegistry, getDatabaseRegistryService } = await import(
      "../../../src/gateway/services/DatabaseRegistryService.js"
    );
    await initializeDatabaseRegistry();
    const registry = getDatabaseRegistryService();
    if (!registry.getById(DB_ID)) {
      await registry.register({ dbId: DB_ID, localPath: path.join(ws.paprHome, "databases", "posts.db"), tursoShortName: DB, syncMode: null });
    }
  });

  afterEach(() => {
    vi.doUnmock("../../../src/gateway/utils/keyResolver.js");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  async function bridge() {
    const { initializeTursoSyncBridge } = await import(
      "../../../src/gateway/services/TursoSyncBridge.js"
    );
    return initializeTursoSyncBridge({ enabled: true });
  }

  it("sends the publisher's app id, not the local copy's", async () => {
    const creds = await (await bridge()).fetchCredentials(DB, { appId: LOCAL_APP });
    expect(requests[0]?.appId).toBe(SOURCE_APP);
    expect(creds.tursoUrl).toBe(PUB_URL);
  });

  it("drops a persisted own-segment token instead of reusing it", async () => {
    const { saveTursoCredentialsEntry, getTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    saveTursoCredentialsEntry(key, { tursoUrl: OWN_URL, authToken: "own-tok" }, Date.now() + 9 * 86_400_000);

    const creds = await (await bridge()).fetchCredentials(DB, { appId: LOCAL_APP });
    expect(requests).toHaveLength(1);
    expect(creds.tursoUrl).toBe(PUB_URL);
    expect(getTursoCredentialsEntry(key)?.tursoUrl).toBe(PUB_URL);
  });

  it("keeps a persisted token that already points at the publisher", async () => {
    const { saveTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    saveTursoCredentialsEntry(key, { tursoUrl: PUB_URL, authToken: "pub-tok" }, Date.now() + 3_600_000);
    const creds = await (await bridge()).fetchCredentials(DB);
    expect(requests).toHaveLength(0);
    expect(creds.authToken).toBe("pub-tok");
  });

  it("refuses (and never caches) a fresh token for the wrong copy", async () => {
    // Server still misses the match (e.g. lineage missing) and answers with an
    // empty own-segment copy no matter what app id we send.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).includes("/v1/cloud/databases/token")) {
          return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        }
        return {
          ok: true,
          json: async () => ({
            tursoUrl: OWN_URL,
            authToken: "own-tok",
            expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
          }),
        };
      }),
    );
    const { getTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    await expect((await bridge()).fetchCredentials(DB, { appId: LOCAL_APP })).rejects.toMatchObject({
      code: "shared_database_unreachable",
    });
    expect(getTursoCredentialsEntry(key)).toBeNull();
  });

  it("offline fallback never returns an expired wrong-copy token", async () => {
    const { saveTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    saveTursoCredentialsEntry(key, { tursoUrl: OWN_URL, authToken: "own-tok" }, Date.now() - 60_000);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(
      (await bridge()).resolveCredentialsForReplicaOpen(DB, { localReplicaExists: true }),
    ).rejects.toThrow();
  });

  it("forgetTursoCredentialsForApp removes the app's tokens (delete / reinstall)", async () => {
    const { saveTursoCredentialsEntry, getTursoCredentialsEntry } = await import(
      "../../../src/gateway/services/tursoCredentialsStore.js"
    );
    await bridge();
    saveTursoCredentialsEntry(key, { tursoUrl: PUB_URL, authToken: "pub-tok" }, Date.now() + 3_600_000);
    const { forgetTursoCredentialsForApp } = await import(
      "../../../src/gateway/services/tursoCredentialsForApp.js"
    );
    expect(await forgetTursoCredentialsForApp(LOCAL_APP, "test")).toEqual([DB]);
    expect(getTursoCredentialsEntry(key)).toBeNull();
  });
});
