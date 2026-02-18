/**
 * Document WebSocket Handlers
 *
 * Supports CRUD, search, favorites, version history, and file-change watching.
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { getDocumentService } from "../services/DocumentService.js";

interface CreateDocumentPayload {
  title: string;
  content?: string;
}

interface UpdateDocumentPayload {
  documentId: string;
  title?: string;
  content?: string;
  tags?: string[];
}

interface DeleteDocumentPayload {
  documentId: string;
}

interface GetDocumentPayload {
  documentId: string;
}

interface SearchDocumentsPayload {
  query: string;
}

interface ToggleFavoritePayload {
  documentId: string;
}

interface VersionsPayload {
  documentId: string;
}

interface GetVersionPayload {
  documentId: string;
  versionId: string;
}

interface RestoreVersionPayload {
  documentId: string;
  versionId: string;
}

interface SaveVersionPayload {
  documentId: string;
  content: string;
  reason?: string;
}

interface ExportDocumentPayload {
  documentId: string;
}

interface WatchDocumentPayload {
  documentId: string;
}

export async function setupDocumentHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const documentService = getDocumentService();

  try {
    switch (message.type) {
      case "document:list": {
        const documents = await documentService.listDocuments();
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:list:response",
            success: true,
            data: documents,
          }),
        );
        break;
      }

      case "document:create": {
        const payload = message.payload as CreateDocumentPayload;
        const document = await documentService.createDocument(
          payload.title,
          payload.content || "",
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:create:response",
            success: true,
            data: document,
          }),
        );
        break;
      }

      case "document:get": {
        const payload = message.payload as GetDocumentPayload;
        const document = await documentService.getDocument(payload.documentId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:get:response",
            success: true,
            data: document,
          }),
        );
        break;
      }

      case "document:update": {
        const payload = message.payload as UpdateDocumentPayload;
        const { documentId, ...updates } = payload;
        const document = await documentService.updateDocument(
          documentId,
          updates,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:update:response",
            success: true,
            data: document,
          }),
        );
        break;
      }

      case "document:delete": {
        const payload = message.payload as DeleteDocumentPayload;
        const success = await documentService.deleteDocument(
          payload.documentId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:delete:response",
            success: true,
            data: { success },
          }),
        );
        break;
      }

      case "document:search": {
        const payload = message.payload as SearchDocumentsPayload;
        const documents = await documentService.searchDocuments(payload.query);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:search:response",
            success: true,
            data: documents,
          }),
        );
        break;
      }

      case "document:toggle-favorite": {
        const payload = message.payload as ToggleFavoritePayload;
        const document = await documentService.toggleFavorite(
          payload.documentId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:toggle-favorite:response",
            success: true,
            data: document,
          }),
        );
        break;
      }

      // ===== Version History =====

      case "document:versions": {
        const payload = message.payload as VersionsPayload;
        const versions = await documentService.getVersionHistory(
          payload.documentId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:versions:response",
            success: true,
            data: versions,
          }),
        );
        break;
      }

      case "document:get-version": {
        const payload = message.payload as GetVersionPayload;
        const version = await documentService.getVersion(
          payload.documentId,
          payload.versionId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:get-version:response",
            success: true,
            data: version,
          }),
        );
        break;
      }

      case "document:restore-version": {
        const payload = message.payload as RestoreVersionPayload;
        const document = await documentService.restoreVersion(
          payload.documentId,
          payload.versionId,
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:restore-version:response",
            success: true,
            data: document,
          }),
        );
        break;
      }

      case "document:save-version": {
        const payload = message.payload as SaveVersionPayload;
        const versionId = await documentService.saveVersion(
          payload.documentId,
          payload.content,
          payload.reason ?? "save",
        );
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:save-version:response",
            success: true,
            data: { versionId },
          }),
        );
        break;
      }

      // ===== Export =====

      case "document:export": {
        const payload = message.payload as ExportDocumentPayload;
        const buffer = await documentService.exportToDocx(payload.documentId);
        const doc = await documentService.getDocument(payload.documentId);
        const filename = `${(doc?.title ?? "document").replace(/[^a-zA-Z0-9_-]/g, "_")}.docx`;

        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:export:response",
            success: true,
            data: {
              filename,
              base64: buffer.toString("base64"),
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
          }),
        );
        break;
      }

      // ===== File Watching =====

      case "document:watch": {
        const payload = message.payload as WatchDocumentPayload;
        documentService.watchDocument(payload.documentId);

        // Register a callback that pushes changes to this WS client
        const unsubscribe = documentService.onFileChange((docId) => {
          if (docId === payload.documentId && ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: "document:content-changed",
                data: { documentId: docId },
              }),
            );
          }
        });

        // Clean up when WS closes
        ws.on("close", () => {
          unsubscribe();
          documentService.unwatchDocument(payload.documentId);
        });

        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:watch:response",
            success: true,
            data: { watching: payload.documentId },
          }),
        );
        break;
      }

      case "document:unwatch": {
        const payload = message.payload as WatchDocumentPayload;
        documentService.unwatchDocument(payload.documentId);
        ws.send(
          JSON.stringify({
            id: message.id,
            type: "document:unwatch:response",
            success: true,
            data: { unwatched: payload.documentId },
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
            error: `Unknown document message type: ${message.type}`,
          }),
        );
    }
  } catch (error) {
    console.error("[Document WS] Error:", error);
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
