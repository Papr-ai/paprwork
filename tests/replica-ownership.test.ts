/**
 * Issue 103 — which engine owns a database is recorded, not inferred from a flag.
 *
 * `shouldSuppressLegacyTursoPush` used to return false whenever the replica
 * rollout flag was absent, so a database registered `syncMode: "replica"` was
 * handed back to the legacy engine — which then reconciled it against a remote
 * it does not own. Ownership has to survive the flag; what the flag decides is
 * whether the replica engine can be *used*, which is a separate question.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isReplicaOwnedRecord,
  resetReplicaOwnershipWarningsForTests,
  warnReplicaOwnedWithoutEngine,
} from "../src/gateway/services/tursoReplica/tursoReplicaOwnership.js";

const ORIGINAL_FLAG = process.env.PAPR_TURSO_REPLICA_SYNC;

beforeEach(() => {
  resetReplicaOwnershipWarningsForTests();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  } else {
    process.env.PAPR_TURSO_REPLICA_SYNC = ORIGINAL_FLAG;
  }
  vi.restoreAllMocks();
});

describe("isReplicaOwnedRecord", () => {
  it("owns a cutover database", () => {
    expect(
      isReplicaOwnedRecord({
        dbId: "db-7129d83e",
        syncMode: "replica",
        cutoverAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("owns a database created replica-native, with no cutoverAt", () => {
    // Requiring cutoverAt would leave these to the legacy engine: they were
    // born replica and were never migrated, so they have no cutover stamp.
    expect(isReplicaOwnedRecord({ dbId: "db-new", syncMode: "replica" })).toBe(
      true,
    );
  });

  it("does not own a legacy database", () => {
    expect(isReplicaOwnedRecord({ dbId: "db-old", syncMode: "legacy" })).toBe(
      false,
    );
  });

  it("does not own a database with no sync mode", () => {
    expect(isReplicaOwnedRecord({ dbId: "db-unset" })).toBe(false);
  });

  it("does not own a missing record", () => {
    expect(isReplicaOwnedRecord(undefined)).toBe(false);
  });

  it("is independent of the rollout flag", () => {
    const record = { dbId: "db-7129d83e", syncMode: "replica" as const };
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    const withFlag = isReplicaOwnedRecord(record);
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    expect(isReplicaOwnedRecord(record)).toBe(withFlag);
  });
});

describe("warnReplicaOwnedWithoutEngine", () => {
  it("names the flag when the rollout is off", () => {
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnReplicaOwnedWithoutEngine({ dbId: "db-7129d83e", syncMode: "replica" });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("db-7129d83e");
    expect(message).toContain("PAPR_TURSO_REPLICA_SYNC");
    // Declining is the point — the message must say the database will not
    // sync, not merely that a flag is unset.
    expect(message).toContain("will not sync");
  });

  it("warns once per database, not once per pass", () => {
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let pass = 0; pass < 10; pass += 1) {
      warnReplicaOwnedWithoutEngine({ dbId: "db-a", syncMode: "replica" });
    }
    warnReplicaOwnedWithoutEngine({ dbId: "db-b", syncMode: "replica" });

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the engine is available", () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnReplicaOwnedWithoutEngine({ dbId: "db-7129d83e", syncMode: "replica" });

    // On darwin-x64 there is no native binding, so the engine is genuinely
    // unavailable and a warning is correct. Anywhere else the flag is enough.
    const nativeUnavailable =
      process.platform === "darwin" && process.arch === "x64";
    expect(warn).toHaveBeenCalledTimes(nativeUnavailable ? 1 : 0);
  });

  it("names the missing native binding on darwin-x64, not the flag", () => {
    // On Intel Mac the engine cannot run whatever the flag says, so pointing
    // the operator at the flag would send them to fix the wrong thing.
    if (!(process.platform === "darwin" && process.arch === "x64")) {
      return;
    }
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnReplicaOwnedWithoutEngine({ dbId: "db-a", syncMode: "replica" });

    expect(String(warn.mock.calls[0]?.[0])).toContain("binding");
  });

  it("falls back to the path when a record has no dbId", () => {
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnReplicaOwnedWithoutEngine({
      localPath: "/Papr/data/databases/papr-books/data.db",
      syncMode: "replica",
    });

    expect(String(warn.mock.calls[0]?.[0])).toContain("papr-books");
  });
});

/** Strip comments so a rationale that *names* the removed gate cannot pass for it. */
function strippedSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("shouldSuppressLegacyTursoPush is not gated on the rollout flag", () => {
  const source = strippedSource(
    "src/gateway/services/tursoReplica/tursoReplicaRouting.ts",
  );

  it("still contains the function", () => {
    // Guard the guard: a rename would otherwise make the assertion below
    // pass against a function that no longer exists.
    expect(source).toContain("export function shouldSuppressLegacyTursoPush");
  });

  it("does not consult isTursoReplicaSyncFeatureEnabled", () => {
    const start = source.indexOf(
      "export function shouldSuppressLegacyTursoPush",
    );
    const body = source.slice(start, start + 1200);

    // Re-adding this gate is the original defect: it hands a replica-owned
    // database back to the legacy engine whenever the flag is absent.
    expect(body).not.toContain("isTursoReplicaSyncFeatureEnabled");
    expect(body).toContain("isReplicaOwnedRecord");
  });
});
