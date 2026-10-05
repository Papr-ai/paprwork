/**
 * Agent tools for first-class database resources.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { getPaprDataDir } from "../utils/paprRoot.js";

const createDatabaseSchema = z.object({
  name: z.string().min(1).describe("Human-readable database label"),
  localPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional absolute path for data.db. Default: $PAPR_HOME/data/databases/{slug}/data.db",
    ),
  isolation: z
    .enum(["shared", "per-user"])
    .optional()
    .describe("Turso isolation: shared (default) or per-user for multi-tenant apps"),
});

const attachDatabaseSchema = z.object({
  appId: z.string().min(1),
  dbId: z.string().min(1),
  alias: z
    .string()
    .min(1)
    .optional()
    .describe(
      "sourceId for /api/db/* (e.g. billing). Do not use legacy alias primary — omit to derive from database name.",
    ),
});

const deleteDatabaseSchema = z.object({
  dbId: z.string().min(1),
  deleteTurso: z
    .boolean()
    .optional()
    .describe(
      "When true and no app references remain, delete Turso replica. Default false. " +
        "Never applies on team track/shared installs (local tombstone only). " +
        "Publisher-only for shared-primary team databases.",
    ),
});

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const createDatabaseTool = createTool({
  id: "create_database",
  description:
    "Create an independent SQLite database (registry entry + local file). " +
    "Schema: papr_db_create_migration({ dbId, name, sql }) — names, writes and applies the migration. Never write_file/bash into migrations/ (blocked; applied migrations are immutable). " +
    "Every synced table MUST have a PRIMARY KEY (INTEGER or TEXT) — required for cloud sync and row versioning. " +
    "Next: attach_database({ appId, dbId, alias }) so the mini-app can read/write via /api/db/* with sourceId. " +
    "Jobs that fill the DB: create_job({ writeDbIds: [dbId] }). " +
    "isolation: 'shared' (default) or 'per-user' (separate Turso DB per signed-in user). " +
    "For anonymous public apps use shared DB + owner_session column; for private multi-user use per-user or papr_user_id + GET /api/access isOwner admin.",
  inputSchema: createDatabaseSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof createDatabaseSchema> }).context ??
      input;

    const { initializeDatabaseRegistry } = await import(
      "../../gateway/services/DatabaseRegistryService.js"
    );

    const slug = slugifyName(args.name);
    const localPath =
      args.localPath ??
      path.join(getPaprDataDir(), "databases", slug, "data.db");

    const { assertEligibleRegistryLocalPath } = await import(
      "../../gateway/services/registryDatabaseEligibility.js"
    );
    assertEligibleRegistryLocalPath(localPath);

    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

    const { ensureRegistryDatabase } = await import(
      "../../gateway/services/jobs/databaseMigrations.js"
    );
    const { shouldDeferRegistrySqliteFileForReplica } = await import(
      "../../gateway/utils/tursoReplicaEnabled.js"
    );
    await ensureRegistryDatabase(localPath, {
      deferSqliteFile: shouldDeferRegistrySqliteFileForReplica(),
    });

    const registry = await initializeDatabaseRegistry();
    const record = await registry.register({
      localPath,
      label: args.name,
      isolation: args.isolation ?? "shared",
    });

    return {
      success: true,
      data: {
        dbId: record.dbId,
        localPath: record.localPath,
        tursoShortName: record.tursoShortName,
        isolation: record.isolation,
        syncMode: record.syncMode ?? "legacy",
      },
    };
  },
});

export const attachDatabaseTool = createTool({
  id: "attach_database",
  description:
    "Link a registry database to a mini-app (data/databases/{slug}/data.db only). " +
    "Never attach Jobs/{jobId}/data/data.db — job scratch is local infra; use writeDbIds on jobs. " +
    "Mini-app code names the DB on every call: sourceId = alias (e.g. 'billing'). " +
    "Reads: POST /api/db/query. Writes: POST /api/db/write. Both endpoints accept sourceId.",
  inputSchema: attachDatabaseSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof attachDatabaseSchema> }).context ??
      input;

    const { getAppService } = await import("../../gateway/services/AppService.js");
    const { initializeDatabaseRegistry } = await import(
      "../../gateway/services/DatabaseRegistryService.js"
    );

    const registry = await initializeDatabaseRegistry();
    const record = registry.getById(args.dbId);
    if (!record) {
      throw new Error(`Database not found in registry: ${args.dbId}`);
    }

    const { assertEligibleRegistryLocalPath } = await import(
      "../../gateway/services/registryDatabaseEligibility.js"
    );
    assertEligibleRegistryLocalPath(record.localPath);

    const appService = getAppService();
    await appService.initialize();

    const app = await appService.getApp(args.appId);
    if (!app) {
      throw new Error(`App not found: ${args.appId}`);
    }

    const { resolveAttachAlias } = await import(
      "../../gateway/services/appDataSources.js"
    );
    const alias = resolveAttachAlias({
      requested: args.alias,
      registryLabel: record.label,
      dbId: args.dbId,
    });
    const dataSources = await appService.linkAppDataSource(args.appId, {
      id: `${args.dbId}:${alias}`,
      type: "sqlite",
      dbId: args.dbId,
      alias,
      dbPath: record.localPath,
      tables: [],
    });

    return {
      success: true,
      data: {
        appId: args.appId,
        dbId: args.dbId,
        dataSources,
      },
    };
  },
});

export const deleteDatabaseTool = createTool({
  id: "delete_database",
  description:
    "Tombstone a registry database when no apps reference it. " +
    "On team track/shared installs you are a collaborator on, this removes the local registry row only (no cloud upload, no Turso delete). " +
    "Publisher shared-primary databases cannot be deleted by collaborators — unlink from apps or remove your local app install. " +
    "Optionally delete Turso replica when deleteTurso=true (publisher-only for shared resources; default false). " +
    "NEVER use to fix schema drift or cutover — that destroys cloud row data. " +
    "For legacy→replica migration use `npm run cutover:replica -- --db-id=<dbId>` (preserves the existing Turso instance).",
  inputSchema: deleteDatabaseSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof deleteDatabaseSchema> }).context ??
      input;

    const { initializeDatabaseRegistry } = await import(
      "../../gateway/services/DatabaseRegistryService.js"
    );
    const registry = await initializeDatabaseRegistry();
    const record = registry.getById(args.dbId);
    if (!record) {
      throw new Error(`Database not found: ${args.dbId}`);
    }

    const refs = await registry.countReferences(args.dbId, record.localPath);
    if (refs > 0) {
      throw new Error(
        `Database ${args.dbId} is still linked by ${refs} app source(s). Unlink first.`,
      );
    }

    const { getPaprRoot, getPaprAppsRoot } = await import("../utils/paprRoot.js");
    const { resolveDatabaseDeleteScope } = await import(
      "../../gateway/services/appDeleteScope.js"
    );
    const referencingAppIds = await registry.listReferencingAppIds(
      args.dbId,
      record.localPath,
    );
    const deleteScope = await resolveDatabaseDeleteScope(
      record.tursoShortName,
      referencingAppIds,
      getPaprAppsRoot(),
      getPaprRoot(),
    );
    if (deleteScope.blockDelete) {
      throw new Error(deleteScope.blockReason ?? "Delete not allowed for this database.");
    }

    await registry.tombstone(args.dbId, {
      skipCloudUpload: deleteScope.localOnly,
    });

    let tursoDeleted = false;
    const deleteTurso = deleteScope.localOnly ? false : args.deleteTurso === true;
    if (deleteTurso) {
      const { getTursoSyncBridge } = await import(
        "../../gateway/services/TursoSyncBridge.js"
      );
      const bridge = getTursoSyncBridge();
      if (bridge) {
        tursoDeleted = await bridge.deleteTursoDatabaseByName(
          record.tursoShortName,
        );
      }
    }

    return {
      success: true,
      data: {
        dbId: args.dbId,
        tombstoned: true,
        tursoDeleted,
        localOnly: deleteScope.localOnly || undefined,
      },
    };
  },
});
