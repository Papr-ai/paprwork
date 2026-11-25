import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isReplicaForkedClientError, rekeyReplicaClientId } from "./replicaForkedClientId.js";

// Real -info written by @tursodatabase/sync 0.8.4 (B's replica, trimmed ids).
const REAL_INFO = {
  version: "v1",
  client_unique_id: "paprwork-desktop-48377c36-e900-445a-b65b-3c6a80758d8f",
  synced_revision: { type: "v1", revision: '{"generation":999999999999999998,"wal_fragment_no":4}' },
  revert_since_wal_salt: null,
  revert_since_wal_watermark: 719,
  last_pull_unix_time: 1795541735,
  last_push_unix_time: 1795506920,
  last_pushed_pull_gen_hint: 0,
};

let dir = "";
let dbPath = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rekey-"));
  dbPath = path.join(dir, "data.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isReplicaForkedClientError", () => {
  it("matches the engine's pull and push forms", () => {
    expect(isReplicaForkedClientError(
      "sync engine operation failed: database sync engine error: protocol error: remote_pull_gen > local_pull_gen: 35 > 34",
    )).toBe(true);
    expect(isReplicaForkedClientError(
      "database sync engine error: protocol error: target_pull_gen > source_pull_gen: 2 > 1",
    )).toBe(true);
  });

  it("does not match other sync, network or checkpoint errors", () => {
    for (const msg of [
      "fetch failed",
      "unable to checkpoint synced portion of WAL",
      "Replica bootstrap backoff active (2 attempts)",
      "replica pull timed out after 15000ms",
      "no such column: s5_real",
      "HTTP 401 Unauthorized",
    ]) {
      expect(isReplicaForkedClientError(msg)).toBe(false);
    }
  });
});

describe("rekeyReplicaClientId", () => {
  it("changes only client_unique_id and keeps every other field", () => {
    writeFileSync(`${dbPath}-info`, JSON.stringify(REAL_INFO));
    const result = rekeyReplicaClientId(dbPath);
    expect(result.ok).toBe(true);
    const next = JSON.parse(readFileSync(`${dbPath}-info`, "utf8"));
    expect(next.client_unique_id).not.toBe(REAL_INFO.client_unique_id);
    expect(next.client_unique_id).toMatch(/^paprwork-desktop-[0-9a-f-]{36}$/);
    const { client_unique_id: _a, ...restNext } = next;
    const { client_unique_id: _b, ...restOld } = REAL_INFO;
    expect(restNext).toEqual(restOld);
    if (result.ok) expect(result.previousId).toBe(REAL_INFO.client_unique_id);
  });

  it("gives a different id every time", () => {
    writeFileSync(`${dbPath}-info`, JSON.stringify(REAL_INFO));
    const a = rekeyReplicaClientId(dbPath);
    const b = rekeyReplicaClientId(dbPath);
    expect(a.ok && b.ok && a.clientId !== b.clientId).toBe(true);
  });

  it("leaves an unknown format untouched (version guard)", () => {
    const future = { ...REAL_INFO, version: "v2" };
    writeFileSync(`${dbPath}-info`, JSON.stringify(future));
    expect(rekeyReplicaClientId(dbPath)).toEqual({ ok: false, reason: "unsupported_format" });
    expect(JSON.parse(readFileSync(`${dbPath}-info`, "utf8"))).toEqual(future);

    const noId = { ...REAL_INFO, client_unique_id: undefined };
    writeFileSync(`${dbPath}-info`, JSON.stringify(noId));
    expect(rekeyReplicaClientId(dbPath)).toEqual({ ok: false, reason: "unsupported_format" });
  });

  it("reports a missing or corrupt file without creating one", () => {
    expect(rekeyReplicaClientId(dbPath)).toEqual({ ok: false, reason: "info_missing" });
    expect(existsSync(`${dbPath}-info`)).toBe(false);
    writeFileSync(`${dbPath}-info`, "{not json");
    expect(rekeyReplicaClientId(dbPath)).toEqual({ ok: false, reason: "info_unreadable" });
    expect(readFileSync(`${dbPath}-info`, "utf8")).toBe("{not json");
  });
});
