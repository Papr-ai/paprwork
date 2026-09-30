import { describe, expect, it } from "vitest";
import {
  isMigrationLedgerMarker,
  shouldSkipMigrationForRemoteLedger,
  shouldVerifyMigrationOnRemote,
} from "../src/gateway/services/jobs/migrationLedgerPolicy.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

describe("migrationLedgerPolicy", () => {
  it("treats baseline markers as ledger-only", () => {
    expect(isMigrationLedgerMarker("0001_baseline")).toBe(true);
    expect(isMigrationLedgerMarker("0001_baseline.sql")).toBe(true);
    expect(isMigrationLedgerMarker("0002_social.sql")).toBe(false);
  });

  it("skips baseline markers for remote ledger bridge", () => {
    expect(shouldSkipMigrationForRemoteLedger("0001_baseline.sql")).toBe(true);
    expect(shouldSkipMigrationForRemoteLedger("0001_init.sql")).toBe(false);
  });

  it("does not verify comment-only baseline migration files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-mig-"));
    const migrationsDir = path.join(root, "migrations");
    await fs.mkdir(migrationsDir, { recursive: true });
    await fs.writeFile(
      path.join(migrationsDir, "0001_baseline.sql"),
      "-- registry database baseline\n",
    );
    await fs.writeFile(
      path.join(migrationsDir, "0002_add_widget.sql"),
      "CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY);\n",
    );

    expect(
      await shouldVerifyMigrationOnRemote(root, "0001_baseline.sql"),
    ).toBe(false);
    expect(
      await shouldVerifyMigrationOnRemote(root, "0002_add_widget.sql"),
    ).toBe(true);
  });
});
