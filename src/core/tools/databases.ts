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
      "Optional absolute path for data.db. Default: ~/Papr/data/databases/{slug}/data.db",
    ),
  isolation: z
    .enum(["shared", "per-user"])
    .optional()
    .describe("Turso isolation: shared (default) or per-user for multi-tenant apps"),
});

const attachDatabaseSchema = z.object({
  appId: z.string().min(1),
  dbId: z.string().min(1),
  alias: z.string().min(1).optional(),
  role: z.enum(["primary", "readonly", "scratch"]).optional(),
  setPrimary: z.boolean().optional(),
});

const deleteDatabaseSchema = z.object({
  dbId: z.string().min(1),
  deleteTurso: z
    .boolean()
    .optional()
    .describe("When true and no app references remain, delete Turso replica"),
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
    "Create an independent SQLite database resource (registry entry + local file). " +
    "Use attach_database to link it to a mini-app. " +
    "isolation: 'shared' (default, one Turso DB for all users) or 'per-user' (separate Turso DB per authenticated user: d-{dbId8}-u-{userId8}). " +
    "Jobs keep JOB_DB as private scratch; do not confuse isolation with cloud publish access settings.",
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

    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    if (!fs.existsSync(localPath)) {
      await fs.promises.writeFile(localPath, "");
    }

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
      },
    };
  },
});

export const attachDatabaseTool = createTool({
  id: "attach_database",
  description:
    "Attach a registry database to a mini-app (alias + role). " +
    "Equivalent to link_app_data_source with dbId instead of jobId.",
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

    const appService = getAppService();
    await appService.initialize();

    const app = await appService.getApp(args.appId);
    if (!app) {
      throw new Error(`App not found: ${args.appId}`);
    }

    const alias = args.alias ?? record.label ?? args.dbId;
    const dataSources = await appService.linkAppDataSource(args.appId, {
      id: `${args.dbId}:${alias}`,
      type: "sqlite",
      dbId: args.dbId,
      alias,
      dbPath: record.localPath,
      tables: [],
      ...(args.role ? { role: args.role } : {}),
      ...(args.setPrimary ? { setPrimary: args.setPrimary } : {}),
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
    "Optionally delete Turso replica when deleteTurso=true.",
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

    await registry.tombstone(args.dbId);

    let tursoDeleted = false;
    if (args.deleteTurso) {
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
      },
    };
  },
});
