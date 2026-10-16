import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACL_COLUMN_MIGRATION_SQL,
  backendActionStarter,
  findPrivateTableBlockers,
} from "../src/gateway/services/tableAccessService.js";
import * as reg from "../src/gateway/services/DatabaseRegistryService.js";

function appTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "papr-apps-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function mockRegistry(privateTables: string[] = [], appIds = ["app-1"]) {
  vi.spyOn(reg, "getDatabaseRegistryService").mockReturnValue({
    getById: () => ({ dbId: "db-1", localPath: "", privateTables }),
    listReferencingAppIds: async () => appIds,
  } as unknown as ReturnType<typeof reg.getDatabaseRegistryService>);
}

describe("tableAccessService", () => {
  let root = "";
  afterEach(() => {
    vi.restoreAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("lists frontend call sites and unfiltered backend reads as blockers", async () => {
    root = appTree({
      "app-1/app.ts": "x\nawait dbQuery(`SELECT * FROM notes`)",
      "app-1/pages/list.ts": "await dbWrite(`UPDATE notes SET a=1`)",
      "app-1/backend/report.py": 'query(con, "SELECT * FROM notes")',
      "app-1/dist/app.js": "SELECT * FROM notes",
    });
    mockRegistry();
    const b = await findPrivateTableBlockers("db-1", "notes", root);
    const sites = b[0]!.issues.map((i) => `${i.rule}@${i.file}:${i.line}`).sort();
    expect(sites).toEqual([
      "table-acl-frontend@app.ts:2",
      "table-acl-frontend@pages/list.ts:1",
      "table-acl-unfiltered@backend/report.py:1",
    ]);
  });

  it("no blockers once code goes through a filtered backend action", async () => {
    root = appTree({
      "app-1/app.ts": "await papr.backend.run('list_notes')",
      "app-1/backend/list_notes.py": 'w,a = acl_read_filter()\nquery(con, f"SELECT * FROM notes WHERE {w}", a)',
    });
    mockRegistry();
    expect(await findPrivateTableBlockers("db-1", "notes", root)).toEqual([]);
  });

  it("only reports the table being switched", async () => {
    root = appTree({ "app-1/app.ts": "await dbQuery(`SELECT * FROM tags`)" });
    mockRegistry(["tags"]);
    expect(await findPrivateTableBlockers("db-1", "notes", root)).toEqual([]);
  });

  it("migration adds nullable _acl (old rows stay public) and a public-read index", () => {
    const sql = ACL_COLUMN_MIGRATION_SQL("notes");
    expect(sql).toMatch(/ALTER TABLE "notes" ADD COLUMN _acl TEXT;/);
    expect(sql).not.toMatch(/UPDATE|DEFAULT/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "idx_notes_acl_public"/);
  });

  it("starter uses the helper filter", () => {
    expect(backendActionStarter("notes")).toMatch(/acl_read_filter\(\)/);
  });
});
