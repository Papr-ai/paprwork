import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  computeMigrationSqlChecksum,
  createMigrationApplyPair,
  getMigrationApplyPair,
  listUnpairedMigrations,
  markMigrationCloudApplied,
  validateMigrationApplyToken,
} from "../src/gateway/services/tursoReplica/migrationApplyPairing.js";

describe("migrationApplyPairing", () => {
  let migrationRoot: string;

  beforeEach(() => {
    migrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-migration-pair-"));
  });

  afterEach(() => {
    fs.rmSync(migrationRoot, { recursive: true, force: true });
  });

  it("creates apply token with checksum and tracks cloud apply", async () => {
    const sql = "ALTER TABLE prospects ADD COLUMN note TEXT;";
    const checksum = computeMigrationSqlChecksum(sql);

    const pair = await createMigrationApplyPair({
      migrationRoot,
      migrationId: "0003_add_note",
      sqlChecksum: checksum,
      replicaAppliedAt: new Date().toISOString(),
    });

    expect(pair.applyToken).toMatch(/^map_/);
    expect(pair.replicaAppliedAt).toBeTruthy();
    expect(pair.pairedAt).toBeNull();

    await validateMigrationApplyToken({
      migrationRoot,
      migrationId: "0003_add_note",
      applyToken: pair.applyToken,
      sqlChecksum: checksum,
    });

    const updated = await markMigrationCloudApplied({
      migrationRoot,
      migrationId: "0003_add_note",
      applyToken: pair.applyToken,
    });

    expect(updated.cloudAppliedAt).toBeTruthy();
    expect(updated.pairedAt).toBeTruthy();

    const unpaired = await listUnpairedMigrations(migrationRoot);
    expect(unpaired).toHaveLength(0);

    const stored = await getMigrationApplyPair(migrationRoot, "0003_add_note");
    expect(stored?.pairedAt).toBeTruthy();
  });

  it("rejects mismatched applyToken", async () => {
    const checksum = computeMigrationSqlChecksum("CREATE TABLE t (id INTEGER);");
    await createMigrationApplyPair({
      migrationRoot,
      migrationId: "0001_init",
      sqlChecksum: checksum,
      replicaAppliedAt: new Date().toISOString(),
    });

    await expect(
      validateMigrationApplyToken({
        migrationRoot,
        migrationId: "0001_init",
        applyToken: "map_deadbeef",
        sqlChecksum: checksum,
      }),
    ).rejects.toThrow(/applyToken mismatch/);
  });
});
