/**
 * App WebSocket Handlers
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { getAppService } from "../services/AppService.js";
import { getCloudAppLineageService } from "../services/CloudAppLineageService.js";
import type { AppFile } from "../services/AppService.js";
import {
  getAppStateStorage,
  type TabMetadata,
  type AppState,
} from "../services/storage/AppStateStorage.js";
import {
  getAppRuntimeLogService,
  type AppRuntimeLogEntry,
  type AppRuntimeLogLevel,
} from "../services/AppRuntimeLogService.js";

async function enrichAppWithLineage<T extends { id: string }>(
  app: T,
  appsRoot: string,
): Promise<T & { cloudLineage?: import("../services/AppService.js").MiniAppCloudLineage }> {
  const lineage = await getCloudAppLineageService(appsRoot).readLineageForApp(app.id);
  if (!lineage) return app;
  return {
    ...app,
    cloudLineage: {
      mode: lineage.mode,
      sourceAppId: lineage.sourceAppId,
      sourceSlug: lineage.sourceSlug,
      sourceNamespaceId: lineage.sourceNamespaceId,
      installedAt: lineage.installedAt,
      lastSyncedAt: lineage.lastSyncedAt,
    },
  };
}

interface CreateAppPayload {
  title: string;
  description: string;
  files: AppFile[];
}

interface UpdateAppPayload {
  appId: string;
  title?: string;
  description?: string;
  icon?: string;
}

interface DeleteAppPayload {
  appId: string;
  unpublishFromCloud?: boolean;
}

interface CopyAppToNamespacePayload {
  appId: string;
  targetOrganizationId: string;
  targetNamespaceId: string;
}

interface AssignAppWorkspacePayload {
  appId: string;
  targetOrganizationId: string;
  targetNamespaceId: string;
}

interface GetAppPayload {
  appId: string;
}

interface ReadAppFilePayload {
  appId: string;
  filename: string;
}

interface WriteAppFilePayload {
  appId: string;
  filename: string;
  content: string;
}

interface GetAppPathPayload {
  appId: string;
}

interface ToggleFavoritePayload {
  appId: string;
}

interface FileVersionsPayload {
  appId: string;
  filename: string;
}

interface FileVersionPayload {
  appId: string;
  filename: string;
  versionId: string;
}

interface RestoreFileVersionPayload {
  appId: string;
  filename: string;
  versionId: string;
}

interface ValidateAppPayload {
  appId: string;
}

interface ListAppFilesPayload {
  appId: string;
}

interface AppRuntimeLogPayload {
  appId: string;
  entry: {
    level: AppRuntimeLogLevel;
    message: string;
    source?: string;
    line?: number;
    column?: number;
    timestamp?: string;
    origin?: "iframe" | "preview";
  };
}

interface GetAppRuntimeLogsPayload {
  appId: string;
  limit?: number;
  sinceMs?: number;
}

interface SearchAppCodePayload {
  appId: string;
  query: string;
  jobIds?: string[];
  scope?: "all" | "app" | "jobs";
  jobFilter?: string[];
  limit?: number;
}

export async function setupAppHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const appService = getAppService();

  try {
    switch (message.type) {
      case "app:list": {
        const apps = await appService.listApps();
        const lineageIndex = await getCloudAppLineageService(
          appService.getAppsRootPath(),
        ).buildIndex();
        const enriched = apps.map((app) => {
          const lineage = lineageIndex.byAppId[app.id];
          if (!lineage) return app;
          return {
            ...app,
            cloudLineage: {
              mode: lineage.mode,
              sourceAppId: lineage.sourceAppId,
              sourceSlug: lineage.sourceSlug,
              sourceNamespaceId: lineage.sourceNamespaceId,
              installedAt: lineage.installedAt,
              lastSyncedAt: lineage.lastSyncedAt,
            },
          };
        });
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:list:response",
            success: true,
            data: enriched,
          }),
        );
        break;
      }

      case "app:list-unassigned": {
        const apps = await appService.listUnassignedApps();
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:list-unassigned:response",
            success: true,
            data: apps,
          }),
        );
        break;
      }

      case "app:assign-workspace": {
        const payload = message.payload as AssignAppWorkspacePayload;
        const result = await appService.assignAppToWorkspace(
          payload.appId,
          payload.targetOrganizationId,
          payload.targetNamespaceId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:assign-workspace:response",
            success: true,
            data: result,
          }),
        );
        break;
      }

      case "app:create": {
        const payload = message.payload as CreateAppPayload;
        const app = await appService.createApp(
          payload.title,
          payload.description,
          payload.files,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:create:response",
            success: true,
            data: app,
          }),
        );
        break;
      }

      case "app:get": {
        const payload = message.payload as GetAppPayload;
        const app = await appService.getApp(payload.appId);
        if (!app) {
          ws.send(
            JSON.stringify({
              id: message.id,
              type: "app:get:response",
              success: false,
              error: "App not found",
            }),
          );
          break;
        }
        const enriched = await enrichAppWithLineage(app, appService.getAppsRootPath());
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:get:response",
            success: true,
            data: enriched,
          }),
        );
        break;
      }

      case "app:update": {
        const payload = message.payload as UpdateAppPayload;
        const { appId, ...updates } = payload;
        const app = await appService.updateApp(appId, updates);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:update:response",
            success: true,
            data: app,
          }),
        );
        break;
      }

      case "app:delete": {
        const payload = message.payload as DeleteAppPayload;
        const result = await appService.deleteApp(payload.appId, {
          unpublishFromCloud: payload.unpublishFromCloud === true,
        });
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:delete:response",
            success: result.deleted,
            data: result,
          }),
        );
        break;
      }

      case "app:copy-to-namespace": {
        const payload = message.payload as CopyAppToNamespacePayload;
        const result = await appService.copyAppToNamespace(
          payload.appId,
          payload.targetOrganizationId,
          payload.targetNamespaceId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:copy-to-namespace:response",
            success: true,
            data: result,
          }),
        );
        break;
      }

      case "app:read-file": {
        const payload = message.payload as ReadAppFilePayload;
        const content = await appService.readAppFile(
          payload.appId,
          payload.filename,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:read-file:response",
            success: true,
            data: { content },
          }),
        );
        break;
      }

      case "app:write-file": {
        const payload = message.payload as WriteAppFilePayload;
        const success = await appService.writeAppFile(
          payload.appId,
          payload.filename,
          payload.content,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:write-file:response",
            success: true,
            data: { success },
          }),
        );
        break;
      }

      case "app:get-path": {
        const payload = message.payload as GetAppPathPayload;
        const appPath = await appService.getAppPath(payload.appId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:get-path:response",
            success: true,
            data: { path: appPath },
          }),
        );
        break;
      }

      case "app:toggle-favorite": {
        const payload = message.payload as ToggleFavoritePayload;
        const app = await appService.toggleFavorite(payload.appId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:toggle-favorite:response",
            success: true,
            data: app,
          }),
        );
        break;
      }

      // ========== APP STATE PERSISTENCE ==========
      case "app:save_tabs": {
        const tabs = message.payload as TabMetadata[];
        getAppStateStorage().saveTabs(tabs);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:save_tabs:response",
            success: true,
          }),
        );
        break;
      }

      case "app:load_tabs": {
        const tabs = getAppStateStorage().loadTabs();
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:load_tabs:response",
            success: true,
            data: tabs,
          }),
        );
        break;
      }

      case "app:save_state": {
        const state = message.payload as AppState;
        getAppStateStorage().saveAppState(state);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:save_state:response",
            success: true,
          }),
        );
        break;
      }

      case "app:load_state": {
        const state = getAppStateStorage().loadAppState();
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:load_state:response",
            success: true,
            data: state,
          }),
        );
        break;
      }

      case "app:toggle_favorite_tab": {
        const { tabId } = message.payload as { tabId: string };
        getAppStateStorage().toggleFavorite(tabId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:toggle_favorite_tab:response",
            success: true,
          }),
        );
        break;
      }

      case "app:get_favorites": {
        const favorites = getAppStateStorage().getFavorites();
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:get_favorites:response",
            success: true,
            data: favorites,
          }),
        );
        break;
      }

      // ========== FILE VERSION HISTORY ==========
      case "app:file-versions": {
        const payload = message.payload as FileVersionsPayload;
        const versions = await appService.getFileVersionHistory(
          payload.appId,
          payload.filename,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:file-versions:response",
            success: true,
            data: versions,
          }),
        );
        break;
      }

      case "app:file-version": {
        const payload = message.payload as FileVersionPayload;
        const version = await appService.getFileVersion(
          payload.appId,
          payload.filename,
          payload.versionId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:file-version:response",
            success: true,
            data: version,
          }),
        );
        break;
      }

      case "app:restore-file-version": {
        const payload = message.payload as RestoreFileVersionPayload;
        const restored = await appService.restoreFileVersion(
          payload.appId,
          payload.filename,
          payload.versionId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:restore-file-version:response",
            success: true,
            data: { restored },
          }),
        );
        break;
      }

      case "app:validate": {
        const payload = message.payload as ValidateAppPayload;
        const result = await appService.validateApp(payload.appId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:validate:response",
            success: true,
            data: result,
          }),
        );
        break;
      }

      case "app:list-files": {
        const payload = message.payload as ListAppFilesPayload;
        const files = await appService.listWorkspaceFiles(payload.appId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:list-files:response",
            success: true,
            data: files,
          }),
        );
        break;
      }

      case "app:runtime-log": {
        const payload = message.payload as AppRuntimeLogPayload;
        if (!payload.appId || !payload.entry?.message) {
          ws.send(
            JSON.stringify({
              id: message.id,
              type: "app:runtime-log:response",
              success: false,
              error: "appId and entry.message required",
            }),
          );
          break;
        }
        const entry: AppRuntimeLogEntry = {
          level: payload.entry.level ?? "log",
          message: payload.entry.message,
          source: payload.entry.source,
          line: payload.entry.line,
          column: payload.entry.column,
          timestamp: payload.entry.timestamp ?? new Date().toISOString(),
          origin: payload.entry.origin ?? "iframe",
        };
        getAppRuntimeLogService().append(payload.appId, entry);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:runtime-log:response",
            success: true,
            data: { stored: true },
          }),
        );
        break;
      }

      case "app:runtime-logs": {
        const payload = message.payload as GetAppRuntimeLogsPayload;
        if (!payload.appId) {
          ws.send(
            JSON.stringify({
              id: message.id,
              type: "app:runtime-logs:response",
              success: false,
              error: "appId required",
            }),
          );
          break;
        }
        const logs = getAppRuntimeLogService().getLogs(payload.appId, {
          limit: payload.limit ?? 100,
          sinceMs: payload.sinceMs,
        });
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:runtime-logs:response",
            success: true,
            data: { logs },
          }),
        );
        break;
      }

      case "app:search-code": {
        const payload = message.payload as SearchAppCodePayload;
        if (!payload.appId || !payload.query?.trim()) {
          ws.send(
            JSON.stringify({
              id: message.id,
              type: "app:search-code:response",
              success: false,
              error: "appId and query required",
            }),
          );
          break;
        }
        const { searchAppCodeInMemory } = await import(
          "../services/AppCodeSearchService.js"
        );
        const data = await searchAppCodeInMemory({
          appId: payload.appId,
          query: payload.query,
          jobIds: payload.jobIds,
          scope: payload.scope,
          jobFilter: payload.jobFilter,
          limit: payload.limit,
        });
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:search-code:response",
            success: true,
            data,
          }),
        );
        break;
      }

      default:
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "error",
            success: false,
            error: `Unknown app message type: ${message.type}`,
          }),
        );
    }
  } catch (error) {
    console.error("[App WS] Error:", error);
    ws.send(
      JSON.stringify({
        id: message.id,
        type: "error",
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
}
