import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bashMigrationWriteBlockReason,
  migrationFileBlockReason,
} from "../src/core/utils/migrationFileGuard.js";
import { resolveEditFileTarget } from "../src/core/utils/resolveEditFileTarget.js";

describe("migration file guard (agent write_file / edit_file / bash)", () => {
  let home: string;
  let orig: string | undefined;
  beforeEach(() => {
    home = path.join(os.tmpdir(), `papr-mig-guard-${Date.now()}`);
    orig = process.env.PAPR_HOME;
    process.env.PAPR_HOME = home;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.PAPR_HOME;
    else process.env.PAPR_HOME = orig;
  });

  it("blocks registry migrations with a pointer to papr_db_create_migration", () => {
    const p = path.join(home, "data", "databases", "billing", "migrations", "0002_add_notes.sql");
    const reason = migrationFileBlockReason(p);
    expect(reason).toContain("papr_db_create_migration");
    expect(reason).toContain("billing");
    expect(resolveEditFileTarget(p)).toMatchObject({ kind: "blocked" });
  });

  it("blocks app-folder copies of migrations too", () => {
    const p = path.join(home, "apps", "app-1", "databases", "billing", "migrations", "0002_x.sql");
    expect(resolveEditFileTarget(p)).toMatchObject({ kind: "blocked" });
  });

  it("does not block other app / job / database files", () => {
    expect(resolveEditFileTarget(path.join(home, "apps", "app-1", "index.html")).kind).toBe("mini_app");
    expect(migrationFileBlockReason(path.join(home, "data", "databases", "billing", "notes.md"))).toBeNull();
    expect(migrationFileBlockReason(path.join(home, "Jobs", "j1", "migrations", "0001_init.sql"))).toBeNull();
    expect(migrationFileBlockReason("/tmp/databases/x/migrations/0001.sql")).toBeNull();
  });

  it("blocks bash writes into migrations, allows reads", () => {
    expect(bashMigrationWriteBlockReason(`cat > $PAPR_HOME/data/databases/b/migrations/0002_x.sql <<EOF`)).toContain("papr_db_create_migration");
    expect(bashMigrationWriteBlockReason(`cp /tmp/a.sql ~/Papr/data/databases/b/migrations/0002_x.sql`)).not.toBeNull();
    expect(bashMigrationWriteBlockReason(`sed -i '' 's/a/b/' data/databases/b/migrations/0001_init.sql`)).not.toBeNull();
    expect(bashMigrationWriteBlockReason(`ls data/databases/b/migrations/`)).toBeNull();
    expect(bashMigrationWriteBlockReason(`cat data/databases/b/migrations/0001_init.sql`)).toBeNull();
  });
});
