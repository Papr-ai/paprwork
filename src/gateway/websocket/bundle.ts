import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";
import {
  getBundleService,
  type ExportBundleInput,
  type ImportBundleInput,
  type ImportCommunityBundleInput,
} from "../services/BundleService.js";

export async function setupBundleHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const bundleService = getBundleService();
  try {
    switch (message.type) {
      case "bundle:list": {
        const bundles = await bundleService.listBundles();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: bundles,
        });
        break;
      }
      case "bundle:export": {
        const payload = message.payload as ExportBundleInput;
        const {
          manifest,
          scrubReport,
          portabilityReport,
          detectedKeys,
          detectedPlatform,
          resolvedJobIds,
        } = await bundleService.exportBundle(payload);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: {
            manifest,
            scrubReport,
            portabilityReport,
            detectedKeys,
            detectedPlatform,
            resolvedJobIds,
          },
        });
        break;
      }
      case "bundle:import": {
        const payload = message.payload as ImportBundleInput;
        const manifest = await bundleService.importBundle(payload);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: manifest,
        });
        break;
      }
      case "bundle:fetch-registry": {
        const registry = await bundleService.fetchCommunityRegistry();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: registry,
        });
        break;
      }
      case "bundle:fetch-community-catalog": {
        const { getCommunityCatalogService } = await import(
          "../services/CommunityCatalogService.js"
        );
        const payload = message.payload as
          | {
              scope?: "global" | "namespace";
              namespaceId?: string;
            }
          | undefined;
        const scope = payload?.scope ?? "global";
        const catalog = await getCommunityCatalogService().fetchScopedCatalog({
          scope,
          namespaceId: payload?.namespaceId,
        });
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: catalog,
        });
        break;
      }
      case "bundle:import-community": {
        const payload = message.payload as ImportCommunityBundleInput;
        const manifest = await bundleService.importCommunityBundle(payload);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: manifest,
        });
        break;
      }
      default:
        sendError(
          ws,
          message.id,
          `Unknown bundle message type: ${message.type}`,
        );
    }
  } catch (error) {
    console.error("[Bundle WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
