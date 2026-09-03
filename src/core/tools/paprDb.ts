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
    "Plan A sync status for a registry database. Two tiers only: " +
    "**replica** (embedded @tursodatabase/sync handle on desktop) and **cloud** (Turso primary). " +
    "Returns online, syncMode, pendingPush, pendingOps, sidecarWedge, cutoverBlocked, lastPushError. " +
    "sidecarWedge means the recorded WAL watermark names a frame the WAL does not hold. " +
    "Connecting now resets those sidecars automatically, so this is normally false; if it stays " +
    "true the replica could not be opened at all and needs repair_cloud_sync. " +
    "Only repair_cloud_sync accept_cloud resets them - 'pull' and 'merge_lww' do NOT, and may report success while doing nothing. " +
    "accept_cloud reseeds local from the Turso primary, so confirm cloud is not missing local-only rows before using it. " +
    "Never sqlite3 the data.db path — that reads the on-disk file, not the replica handle. " +
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
    "Automated dual apply: embedded replica → Turso primary (HTTP) → pull to align. " +
    "Never pushes DDL via replica push — avoids schema drift on Turso. " +
    "Updates __papr__/app-meta.json requiredSchemaVersion for the schema-owner app. " +
    "Workflow: write_file migration → papr_db_apply_migration → rebuild dist if UI changed → Upload now. " +
    "For manual control use papr_db_apply_migration_replica then papr_db_apply_migration_cloud.",
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

export const paprDbApplyMigrationReplicaTool = createTool({
  id: "papr_db_apply_migration_replica",
  description:
    "Apply migrations/{id}.sql on the embedded replica only (no push to Turso primary). " +
    "Returns applyToken and sqlChecksum — pass both to papr_db_apply_migration_cloud. " +
    "Use when debugging split-brain or when cloud apply must be verified separately.",
  inputSchema: paprDbApplyMigrationSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const { paprDbApplyMigrationReplica } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbApplyMigrationReplica(args);
    return { success: true, data };
  },
});

const paprDbApplyMigrationCloudSchema = paprDbApplyMigrationSchema.extend({
  applyToken: z
    .string()
    .min(1)
    .describe("Token from papr_db_apply_migration_replica"),
});

export const paprDbApplyMigrationCloudTool = createTool({
  id: "papr_db_apply_migration_cloud",
  description:
    "Apply the same migration on Turso primary via HTTP. Requires applyToken from " +
    "papr_db_apply_migration_replica (checksum must match). Then run " +
    "papr_db_reconcile_sync({ action: 'pull_and_align' }) to align replica frames.",
  inputSchema: paprDbApplyMigrationCloudSchema,
  execute: async (input) => {
    const args = unwrapContext(input);
    const { paprDbApplyMigrationCloud } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbApplyMigrationCloud(args);
    return { success: true, data };
  },
});

export const paprDbMigrationParityTool = createTool({
  id: "papr_db_migration_parity",
  description:
    "Compare **replica** vs **cloud** for a registry DB: migration ledgers AND user table lists. " +
    "ledgerPaired can be true while schemaPaired is false (split-brain — the bug merge_lww hides). " +
    "Inspect replicaOnlyTables / cloudOnlyTables before declaring recovery done.",
  inputSchema: z.object({
    dbId: z.string().min(1),
  }),
  execute: async (input) => {
    const args = unwrapContext(input);
    const { paprDbMigrationParity } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbMigrationParity(args);
    return { success: true, data };
  },
});

export const paprDbReconcileSyncTool = createTool({
  id: "papr_db_reconcile_sync",
  description:
    "Repair Plan A replica sync without pushing DDL. Actions: " +
    "repair_sidecar_wedge (reset corrupt sidecars + pull), " +
    "pull_and_align (pull after cloud migration), " +
    "clear_push_error (clear lastReplicaPushError), " +
    "complete_pairing (mark replica+cloud paired after manual steps), " +
    "full_parity_check (ledger + wedge report), " +
    "dedupe_migration_ledger (remove legacy duplicate ids like 0001_init.sql when 0001_init exists). " +
    "Prefer this over repair_cloud_sync merge_lww for schema issues.",
  inputSchema: z.object({
    dbId: z.string().min(1),
    action: z.enum([
      "repair_sidecar_wedge",
      "pull_and_align",
      "clear_push_error",
      "complete_pairing",
      "full_parity_check",
      "dedupe_migration_ledger",
    ]),
    applyToken: z.string().optional(),
    migrationId: z.string().optional(),
  }),
  execute: async (input) => {
    const args = unwrapContext(input);
    const { paprDbReconcileSync } = await import(
      "../../gateway/services/tursoReplica/PaprDbService.js"
    );
    const data = await paprDbReconcileSync(args);
    return { success: true, data };
  },
});

export const repairCloudSyncTool = createTool({
  id: "repair_cloud_sync",
  description:
    "Repair Plan A Turso replica sync for a registry database. " +
    "Use when row push fails or local/cloud data diverged. " +
    "For schema/migration issues prefer papr_db_migration_parity + papr_db_reconcile_sync " +
    "and explicit papr_db_apply_migration_replica/cloud — NOT merge_lww. " +
    "Strategies: pull (refresh from cloud), push (pull-first then push rows), " +
    "accept_cloud (reseed local from Turso primary — NEVER when local has more rows than Turso), " +
    "merge_lww (DEPRECATED — only rebases ledger via DELETE; use papr_db_reconcile_sync instead), " +
    "force_local (replica WAL push — does NOT upload rows inserted via bash/sqlite3), " +
    "bootstrap_remote (full table snapshot from local file to Turso primary, then reseed replica), " +
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
      .describe(
        "Repair action. Avoid merge_lww for schema fixes — use papr_db_reconcile_sync.",
      ),
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
  paprDbApplyMigrationReplicaTool,
  paprDbApplyMigrationCloudTool,
  paprDbMigrationParityTool,
  paprDbReconcileSyncTool,
  repairCloudSyncTool,
];
