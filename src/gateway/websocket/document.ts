/**
 * Document WebSocket Handlers
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
