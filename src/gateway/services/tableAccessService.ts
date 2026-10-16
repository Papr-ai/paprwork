/**
 * Switch one table between public and private.
 *
 * public → private:
 *   1. Table must exist.
 *   2. Every app linked to the DB is linted against the would-be private set.
 *      Any frontend call site or unfiltered backend read → refuse, return the
 *      sites + a backend action starter. Nothing changes until the code is fixed.
 *   3. Adds `_acl TEXT` (+ public-read index) via a normal migration when
 *      missing. Existing rows keep `_acl` NULL = public; backfilling them is an
 *      explicit migration the agent writes if the user wants it.
 *   4. Records the table in the registry and refreshes linked-databases.json so
 *      the switch ships with the next publish.
 *
 * private → public: registry change only (column + data untouched).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
  normalizeTableName,
  privateTablesOf,
  type TableAccess,
} from "./DatabaseRegistryService.js";
import {
  checkMiniAppTableAcl,
  summarizeTableAclIssues,
  type TableAclIssue,
} from "../utils/miniAppTableAclLint.js";

export const TABLE_PRIVATE_BLOCKED = "table_private_blocked";

export interface TableAccessResult {
  ok: boolean;
  dbId: string;
  table: string;
  access: TableAccess;
  privateTables: string[];
  addedAclColumn?: boolean;
  migrationId?: string;
  /** Present when ok=false. */
  error?: {
    code: typeof TABLE_PRIVATE_BLOCKED;
    message: string;
    table: string;
    sites: Array<{ appId: string; rule: string; sites: string[] }>;
    backendStarter: string;
  };
}

const SKIP_DIRS = new Set(["node_modules", "dist", "__papr__", "databases", ".git"]);

async function readAppSourceFiles(appDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(appDir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(r);
      } else if (/\.(ts|tsx|js|jsx|html|py)$/.test(e.name)) {
        out.set(r, await fs.readFile(path.join(appDir, r), "utf8").catch(() => ""));
      }
    }
  }
  await walk("");
  return out;
}

export function backendActionStarter(table: string): string {
  return [
    `# backend/list_${table}.py  — manifest: "list_${table}": { "handler": "list_${table}.py", "effect": "read" }`,
    "from papr_db import connect, query, acl_read_filter",
    "",
    "def handler(params):",
    "    con = connect()",
    "    where, args = acl_read_filter()",
    `    rows = query(con, f"SELECT * FROM ${table} WHERE {where} ORDER BY rowid DESC LIMIT 200", args).rows`,
    "    return {\"rows\": rows}",
    "",
    "# frontend: const { rows } = await papr.backend.run(\"list_" + table + "\")",
    "# inserts: write(con, \"INSERT INTO " + table + "(..., _acl) VALUES (..., ?)\", [..., acl_for_caller()])",
  ].join("\n");
}

/** Lint every app linked to dbId as if `table` were private. */
export async function findPrivateTableBlockers(
  dbId: string,
  table: string,
  appsRoot = path.join(getPaprRoot(), "apps"),
): Promise<Array<{ appId: string; issues: TableAclIssue[] }>> {
  const registry = getDatabaseRegistryService();
  const record = registry.getById(dbId);
  if (!record) throw new Error(`Database not found: ${dbId}`);
  const priv = new Set([...privateTablesOf(record), table]);
  const appIds = await registry.listReferencingAppIds(dbId, record.localPath ?? "");
  const out: Array<{ appId: string; issues: TableAclIssue[] }> = [];
  for (const appId of appIds) {
    const files = await readAppSourceFiles(path.join(appsRoot, appId));
    const issues = checkMiniAppTableAcl(files, priv).filter((i) => i.table === table);
    if (issues.length) out.push({ appId, issues });
  }
  return out;
}

export const ACL_COLUMN_MIGRATION_SQL = (table: string): string =>
  `ALTER TABLE "${table}" ADD COLUMN _acl TEXT;\n` +
  `CREATE INDEX IF NOT EXISTS "idx_${table}_acl_public" ON "${table}" ` +
  `(json_extract(_acl, '$."*".read'));\n`;

export async function setTableAccess(input: {
  dbId: string;
  table: string;
  access: TableAccess;
}): Promise<TableAccessResult> {
  await initializeDatabaseRegistry();
  const table = normalizeTableName(input.table);
  const registry = getDatabaseRegistryService();
  const { paprDbQuery, paprDbCreateMigration } = await import("./tursoReplica/PaprDbService.js");

  if (input.access === "private") {
    const exists = await paprDbQuery({
      dbId: input.dbId,
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND lower(name)=?",
      params: [table],
    });
    if (exists.count === 0) throw new Error(`Table "${table}" does not exist in ${input.dbId}`);

    const blockers = await findPrivateTableBlockers(input.dbId, table);
    if (blockers.length) {
      const record = registry.getById(input.dbId);
      return {
        ok: false,
        dbId: input.dbId,
        table,
        access: input.access,
        privateTables: [...privateTablesOf(record)],
        error: {
          code: TABLE_PRIVATE_BLOCKED,
          table,
          message:
            `Can't make "${table}" private yet — the code below would break on the web. ` +
            "Move frontend reads/writes into a backend action and filter backend reads with acl_read_filter(), then retry.",
          sites: blockers.flatMap((b) =>
            summarizeTableAclIssues(b.issues).map((s) => ({ appId: b.appId, rule: s.rule, sites: s.sites })),
          ),
          backendStarter: backendActionStarter(table),
        },
      };
    }

    const cols = await paprDbQuery({
      dbId: input.dbId,
      sql: `SELECT name FROM pragma_table_info('${table}') WHERE name = '_acl'`,
    });
    let migrationId: string | undefined;
    if (cols.count === 0) {
      const created = await paprDbCreateMigration({
        dbId: input.dbId,
        name: `${table}_acl`,
        sql: ACL_COLUMN_MIGRATION_SQL(table),
      });
      migrationId = created.migrationId;
    }
    const privateTables = await registry.setTableAccess(input.dbId, table, "private");
    await refreshLinkedDatabases(input.dbId);
    return {
      ok: true,
      dbId: input.dbId,
      table,
      access: "private",
      privateTables,
      addedAclColumn: Boolean(migrationId),
      ...(migrationId ? { migrationId } : {}),
    };
  }

  const privateTables = await registry.setTableAccess(input.dbId, table, "public");
  await refreshLinkedDatabases(input.dbId);
  return { ok: true, dbId: input.dbId, table, access: "public", privateTables };
}

async function refreshLinkedDatabases(dbId: string): Promise<void> {
  const registry = getDatabaseRegistryService();
  const record = registry.getById(dbId);
  if (!record) return;
  const { writeLinkedDatabasesForApp } = await import("./cloudSync/linkedDatabasesForCloud.js");
  for (const appId of await registry.listReferencingAppIds(dbId, record.localPath ?? "")) {
    await writeLinkedDatabasesForApp(getPaprRoot(), appId).catch(() => undefined);
  }
}
