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
import type { AppDataSource } from "../services/AppService.js";

function extractPrimaryTable(sql: string): string | null {
  const s = sql.trim();
  let m = s.match(/\bINSERT\s+INTO\s+["'`]?(\w+)/i);
  if (m) return m[1];
  m = s.match(/\bUPDATE\s+["'`]?(\w+)/i);
  if (m) return m[1];
  m = s.match(/\bDELETE\s+FROM\s+["'`]?(\w+)/i);
  if (m) return m[1];
  m = s.match(/\bFROM\s+["'`]?(\w+)/i);
  if (m) return m[1];
  return null;
}

async function resolveDataSource(
  sources: AppDataSource[],
  sourceId?: string,
  sql?: string,
): Promise<AppDataSource> {
  if (sourceId) {
    const found = sources.find(
      (s) => s.id === sourceId || s.alias === sourceId,
    );
    if (!found) {
      const available = sources.map((s) => s.alias ?? s.id).join(", ");
      throw Object.assign(
        new Error(
          `Data source "${sourceId}" not found. Available: ${available}`,
        ),
        { status: 404 },
      );
    }
    return found;
  }
  if (sources.length === 1) return sources[0];
  const tableName = sql ? extractPrimaryTable(sql) : null;
  if (tableName) {
    const DatabaseCtor = (await import("better-sqlite3")).default;
    for (const source of sources) {
      try {
        const db = new DatabaseCtor(source.dbPath, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const row = db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
            )
            .get(tableName) as unknown;
          if (row !== undefined) return source;
        } finally {
          db.close();
        }
      } catch {
        /* skip unreadable source */
      }
    }
  }
  const aliases = sources.map((s) => `"${s.alias ?? s.id}"`).join(", ");
  const tableHint = tableName
    ? ` Table "${tableName}" was not found in any linked source.`
    : "";
  throw Object.assign(
    new Error(
      `Multiple data sources are linked (${aliases}) and the target could not be determined automatically.${tableHint} Pass sourceId to specify which source to use.`,
    ),
    { status: 400 },
  );
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
        const apps = await appService.listApps();
        const result: AppViewEntry[] = [];
        const DatabaseCtor = (await import("better-sqlite3")).default;

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
              const db = new DatabaseCtor(source.dbPath, {
                readonly: true,
                fileMustExist: true,
              });
              const tableNames = (
                db
                  .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                  )
                  .all() as { name: string }[]
              ).map((r) => ({ table: r.name }));
              db.close();
              appEntry.sources.push({
                sourceId: source.id,
                alias: source.alias,
                tables: tableNames,
              });
            } catch {
              appEntry.sources.push({
                sourceId: source.id,
                alias: source.alias,
                tables: [],
              });
            }
          }
          result.push(appEntry);
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
        const appId = payload?.appId;
        if (!appId) {
          sendError(ws, message.id, "appId is required");
          return;
        }
        const sources = await appService.listAppDataSources(appId);
        if (!sources.length) {
          sendResponse(ws, {
            id: message.id,
            success: true,
            data: { sources: [] },
          });
          return;
        }
        const DatabaseCtor = (await import("better-sqlite3")).default;
        const result = sources.map((source) => {
          try {
            const db = new DatabaseCtor(source.dbPath, {
              readonly: true,
              fileMustExist: true,
            });
            const tables = (
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                )
                .all() as { name: string }[]
            ).map((row) => {
              const cols = db
                .prepare(`PRAGMA table_info(${JSON.stringify(row.name)})`)
                .all() as {
                cid: number;
                name: string;
                type: string;
                notnull: number;
                dflt_value: unknown;
                pk: number;
              }[];
              return {
                table: row.name,
                columns: cols.map((c) => ({
                  name: c.name,
                  type: c.type,
                  pk: c.pk === 1,
                })),
              };
            });
            db.close();
            return {
              sourceId: source.id,
              alias: source.alias,
              dbPath: source.dbPath,
              tables,
            };
          } catch (err) {
            return {
              sourceId: source.id,
              alias: source.alias,
              dbPath: source.dbPath,
              error: (err as Error).message,
            };
          }
        });
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { sources: result },
        });
        break;
      }

      case "db:query": {
        const payload = message.payload as DbQueryPayload;
        const { appId, sql, params, sourceId } = payload ?? {};
        if (!appId || !sql) {
          sendError(ws, message.id, "appId and sql are required");
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
        const sources = await appService.listAppDataSources(appId);
        if (!sources.length) {
          sendError(
            ws,
            message.id,
            `No data sources linked to app ${appId}. Use link_app_data_source first.`,
          );
          return;
        }
        const source = await resolveDataSource(sources, sourceId, sql);
        const DatabaseCtor = (await import("better-sqlite3")).default;
        const db = new DatabaseCtor(source.dbPath, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const stmt = db.prepare(sql);
          const rows = stmt.all(
            ...(Array.isArray(params) ? params : []),
          ) as Record<string, unknown>[];
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          sendResponse(ws, {
            id: message.id,
            success: true,
            data: {
              rows,
              columns,
              count: rows.length,
              source: source.alias,
            },
          });
        } finally {
          db.close();
        }
        break;
      }

      default:
        sendError(ws, message.id, `Unknown db message type: ${message.type}`);
    }
  } catch (error) {
    console.error("[Db WS] Error:", error);
    const err = error as Error & { status?: number };
    sendError(ws, message.id, err.message || "Database operation failed");
  }
}
