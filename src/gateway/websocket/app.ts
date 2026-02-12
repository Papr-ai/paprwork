/**
 * App WebSocket Handlers
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { getAppService } from "../services/AppService.js";
import type { AppFile } from "../services/AppService.js";

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

export async function setupAppHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const appService = getAppService();

  try {
    switch (message.type) {
      case "app:list": {
        const apps = await appService.listApps();
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:list:response",
            success: true,
            data: apps,
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
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:get:response",
            success: true,
            data: app,
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
        const success = await appService.deleteApp(payload.appId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "app:delete:response",
            success: true,
            data: { success },
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
