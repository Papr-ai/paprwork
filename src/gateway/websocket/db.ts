/**
 * Database WebSocket Handlers
 *
 * Exposes app-linked SQLite schema and query APIs to the UI (e.g. Data Views sidebar).
 * Uses the same logic as the HTTP /api/db/* routes for mini-apps.
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { getAppService } from "../services/AppService.js";
import type { AppDataSource } from "../services/appDataSources.js";
import { resolveAppDataSource } from "../services/appDataSources.js";
import { getDbPool } from "../services/DbQueryPool.js";
import { getDbRouter } from "../services/appRuntime/DbRouter.js";
import path from "path";

async function resolveLinkedSource(
  appId: string,
  sourceId: string | undefined,
  sql: string | undefined,
  operation: "read" | "write",
): Promise<AppDataSource> {
  const appService = getAppService();
  const config = await appService.getDataSourcesConfig(appId);
  if (!config.sources.length) {
    throw Object.assign(
      new Error(
        `No data sources linked to app ${appId}. Use link_app_data_source first.`,
      ),
      { status: 404 },
    );
  }
  const pool = getDbPool();
  const router = getDbRouter();
  return resolveAppDataSource(config, {
    sourceId,
    sql,
    operation,
    tableExists: (dbPath, table) => {
      const source = config.sources.find(
        (entry) => path.normalize(entry.dbPath) === path.normalize(dbPath),
      );
      if (!source) {
        return pool.tableExists(dbPath, table);
      }
      return router.tableExists(dbPath, table, source);
    },
  });
}

interface DbSchemaPayload {
  appId: string;
}

interface DbQueryPayload {
  appId: string;
  sql: string;
  params?: unknown[];
  sourceId?: string;
}

interface AppViewEntry {
  appId: string;
  appTitle: string;
  sources: Array<{
    sourceId: string;
    alias: string;
    tables: Array<{ table: string }>;
  }>;
}

export async function setupDbHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const appService = getAppService();

  try {
    switch (message.type) {
      case "db:list-all-views": {
        const router = getDbRouter();
        const apps = await appService.listApps();
        const result: AppViewEntry[] = [];

        for (const app of apps) {
          let sources;
          try {
            sources = await appService.listAppDataSources(app.id);
          } catch {
            continue;
          }
          if (!sources.length) continue;

          const appEntry: AppViewEntry = {
            appId: app.id,
            appTitle: app.title,
            sources: [],
          };

          for (const source of sources) {
            try {
              const schema = await router.schema(source.dbPath, source);
              appEntry.sources.push({
                sourceId: source.id,
                alias: source.alias,
                tables: schema.tables.map((t) => ({ table: t.table })),
              });
            } catch {
              // skip unreadable source
            }
          }

          if (appEntry.sources.length > 0) {
            result.push(appEntry);
          }
        }

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { apps: result },
        });
        break;
      }

      case "db:schema": {
        const payload = message.payload as DbSchemaPayload;
        const { appId } = payload;
        if (!appId) {
          sendError(ws, message.id, "appId required");
          return;
        }

        const router = getDbRouter();
        const sources = await appService.listAppDataSources(appId);
        const result = await Promise.all(
          sources.map(async (source) => {
            try {
              const schema = await router.schema(source.dbPath, source);
              return {
                sourceId: source.id,
                alias: source.alias,
                dbPath: source.dbPath,
                role: source.role,
                tables: schema.tables,
              };
            } catch (err) {
              return {
                sourceId: source.id,
                alias: source.alias,
                dbPath: source.dbPath,
                role: source.role,
                error: (err as Error).message,
              };
            }
          }),
        );

        const config = await appService.getDataSourcesConfig(appId);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: {
            primary: config.primary,
            sources: result,
          },
        });
        break;
      }

      case "db:query": {
        const payload = message.payload as DbQueryPayload;
        const { appId, sql, params, sourceId } = payload;
        if (!appId || !sql) {
          sendError(ws, message.id, "appId and sql required");
          return;
        }

        const trimmed = sql.trim().toLowerCase();
        if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
          sendError(
            ws,
            message.id,
            "Only SELECT (and WITH ... SELECT) queries are allowed",
          );
          return;
        }

        let source: AppDataSource;
        try {
          source = await resolveLinkedSource(appId, sourceId, sql, "read");
        } catch (err) {
          const e = err as Error & { status?: number };
          sendError(ws, message.id, e.message);
          return;
        }

        const router = getDbRouter();
        const result = await router.query(appId, source, sql, params);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { ...result, source: source.alias },
        });
        break;
      }

      default:
        sendError(ws, message.id, `Unknown db message type: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, (error as Error).message);
  }
}
