/**
 * Agent tools for Plan A Turso replica DB sync (papr_db_*).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

function unwrapContext<T>(input: T | { context?: T }): T {
  if (input && typeof input === "object" && "context" in input) {
    return (input as { context?: T }).context ?? (input as T);
  }
  return input as T;
}

const dbRefSchema = z.object({
  dbId: z
    .string()
    .min(1)
    .optional()
    .describe("Registry dbId from create_database"),
  localPath: z
    .string()
    .min(1)
    .optional()
    .describe("Absolute path to data.db (alternative to dbId)"),
});

export const paprDbSyncStatusTool = createTool({
  id: "papr_db_sync_status",
  description:
    "Plan A Turso replica sync status for a registry database. " +
    "Returns online, syncMode, pendingPush, pendingOps, sidecarWedge, cutoverBlocked, lastPushError. " +
    "    "When sidecarWedge is true, pull/push/migration will fail until sidecars are reset. " +
    "Only repair_cloud_sync accept_cloud resets them — 'pull' and 'merge_lww' do NOT, and may report success while doing nothing. " +
    "accept_cloud reseeds local from the Turso primary, so confirm cloud is not missing local-only rows before using it. "" +
    "Requires PAPR_TURSO_REPLICA_SYNC and Papr cloud sync enabled.",
  inputSchema: dbRefSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    if (!args.dbId && !args.localPath) {
      throw new Error("dbId or localPath is required");
    }
    const { paprDbSyncStatus } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbSyncStatus(args);
    return { success: true, data };
  },
});

export const paprDbPushTool = createTool({
  id: "papr_db_push",
  description:
    "Recovery only: push local replica rows to Turso primary. " +
    "Under Plan A cloud sync, DML auto-pushes when online — use repair_cloud_sync instead. " +
    "Hidden from main agent when cloud sync + replica rollout are active.",
  inputSchema: dbRefSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    if (!args.dbId && !args.localPath) {
      throw new Error("dbId or localPath is required");
    }
    const { paprDbPush } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbPush(args);
    return { success: true, data };
  },
});

export const paprDbPullTool = createTool({
  id: "papr_db_pull",
  description:
    "Recovery only: pull Turso primary into local replica. " +
    "Prefer repair_cloud_sync({ strategy: 'pull' | 'accept_cloud' }) under Plan A. " +
    "Hidden from main agent when cloud sync + replica rollout are active.",
  inputSchema: dbRefSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    if (!args.dbId && !args.localPath) {
      throw new Error("dbId or localPath is required");
    }
    const { paprDbPull } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbPull(args);
    return { success: true, data };
  },
});

const paprDbExecSchema = dbRefSchema.extend({
  sql: z.string().min(1).describe("SQL to execute (DML or DDL)"),
  params: z.array(z.unknown()).optional().describe("Bound params for DML"),
});

export const paprDbExecTool = createTool({
  id: "papr_db_exec",
  description:
    "Execute DML (INSERT/UPDATE/DELETE/REPLACE) on a Plan A registry database. " +
    "Writes local replica then push() to Turso primary when online. " +
    "Schema is NOT allowed — write migrations/*.sql and use papr_db_apply_migration.",
  inputSchema: paprDbExecSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    if (!args.dbId && !args.localPath) {
      throw new Error("dbId or localPath is required");
    }
    const { paprDbExec } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbExec(args);
    return { success: true, data };
  },
});

const paprDbApplyMigrationSchema = z.object({
  dbId: z.string().min(1),
  migrationId: z
    .string()
    .min(1)
    .describe("Migration filename without .sql, e.g. 0001_init"),
});

export const paprDbApplyMigrationTool = createTool({
  id: "papr_db_apply_migration",
  description:
    "Apply migrations/{id}.sql to a registry database (Plan A schema path). " +
    "When cloud sync is on: executes on Turso primary (memory-server credentials), " +
    "records schema_migrations, then pull() local replica. Updates __papr__/app-meta.json " +
    "requiredSchemaVersion for the schema-owner app. " +
    "Workflow: write_file migration → papr_db_apply_migration → rebuild dist if UI changed → Upload now " +
    "(manual upload mode) so apps.papr.ai serves the new bundle.",
  inputSchema: paprDbApplyMigrationSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const { paprDbApplyMigration } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbApplyMigration(args);
    return { success: true, data };
  },
});

export const repairCloudSyncTool = createTool({
  id: "repair_cloud_sync",
  description:
    "Repair Plan A Turso replica sync for a registry database. " +
    "Use when push fails with MIGRATION_CONFLICT or local/cloud schema diverged. " +
    "Strategies: pull (refresh from cloud), push (pull-first then push), " +
    "accept_cloud (reseed local from Turso primary — NEVER when local has more rows than Turso), " +
    "merge_lww (pull → push → rebase cloud-ahead migrations → retry), " +
    "force_local (replica WAL push — does NOT upload rows inserted via bash/sqlite3), " +
    "bootstrap_remote (full table snapshot from local file to Turso primary, then reseed replica — use when local is authoritative but Turso is empty/stale), " +
    "export_conflicts (inspect migration ledger conflicts without changing data).",
  inputSchema: z.object({
    dbId: z.string().min(1).describe("Registry dbId"),
    strategy: z
      .enum([
        "pull",
        "push",
        "accept_cloud",
        "merge_lww",
        "force_local",
        "bootstrap_remote",
        "export_conflicts",
      ])
      .describe("Repair action"),
  }),
  execute: async (input) => {
    const args = unwrapContext(input);
    const { repairCloudSync } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await repairCloudSync(args);
    return { success: true, data };
  },
});

export const paprDbTools = [
  paprDbSyncStatusTool,
  paprDbPushTool,
  paprDbPullTool,
  paprDbExecTool,
  paprDbApplyMigrationTool,
  repairCloudSyncTool,
];
