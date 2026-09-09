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
    "pendingOps/cdcOperations on syncMode=replica is normal Turso Sync pending push — NOT legacy CDC; check syncMode first. " +
    "sidecarWedge means the recorded WAL watermark names a frame the WAL does not hold. " +
    "Connecting now resets those sidecars automatically, so this is normally false; if it stays " +
    "true the replica could not be opened at all and needs repair_cloud_sync. " +
    "Repair escalation (try in order — do not skip to accept_cloud unless needed): " +
    "(1) repair_cloud_sync pull — refresh from cloud; " +
    "(2) papr_db_reconcile_sync repair_sidecar_wedge — reset sidecars + pull (auto full reseed if WAL I/O persists); " +
    "(3) accept_cloud — LAST RESORT: wipe local replica and re-pull from Turso primary. " +
    "Only use accept_cloud after confirming Turso has the rows you need (local-only unpushed data is lost). " +
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
    "Workflow: write_file migration → papr_db_apply_migration → rebuild dist if UI changed → Publish changes. " +
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
    "Repair Plan A replica sync without pushing DDL. Try these before accept_cloud. Actions: " +
    "repair_sidecar_wedge (reset corrupt sidecars + pull; escalates to full reseed if WAL I/O persists), " +
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
    "Try strategies in order: pull (refresh from cloud) → papr_db_reconcile_sync repair_sidecar_wedge (sidecar/WAL) → " +
    "accept_cloud (LAST RESORT — wipe local replica, re-pull from Turso; only when Turso has the data you need). " +
    "Other strategies: push (pull-first then push rows), " +
    "force_local (replica sync push — does NOT upload rows inserted via bash/sqlite3), " +
    "bootstrap_remote (Plan A: sync push to Turso then reseed replica; legacy syncMode: HTTP table snapshot), " +
    "export_conflicts (inspect migration ledger conflicts without changing data). " +
    "merge_lww is DEPRECATED — use papr_db_reconcile_sync instead.",
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
