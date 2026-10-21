import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { bumpRemoteSyncVersion, readRemoteSyncVersion } from "../src/gateway/services/tursoSyncBridgeCore.js";

describe("bumpRemoteSyncVersion (single batch)", () => {
  it("creates the meta table, increments, and returns the new version in one round trip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-"));
    const client = createClient({ url: `file:${path.join(dir, "t.db")}` });
    let calls = 0;
    const origBatch = client.batch.bind(client);
    const origExec = client.execute.bind(client);
    (client as any).batch = (...a: any[]) => { calls++; return (origBatch as any)(...a); };
    (client as any).execute = (...a: any[]) => { calls++; return (origExec as any)(...a); };
    expect(await bumpRemoteSyncVersion(client)).toBe(1);
    expect(calls).toBe(1);
    expect(await bumpRemoteSyncVersion(client)).toBe(2);
    expect(await bumpRemoteSyncVersion(client)).toBe(3);
    expect(await readRemoteSyncVersion(client)).toBe(3);
    client.close();
  });

  it("never throws on a broken client", async () => {
    const bad = { batch: async () => { throw new Error("down"); } } as any;
    expect(await bumpRemoteSyncVersion(bad)).toBeUndefined();
  });
});
