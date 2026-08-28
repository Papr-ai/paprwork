import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { getPaprClient } from "../../core/tools/paprClient.js";

export interface AttachmentMemoryUploadResult {
  uploadId: string | null;
  status: string;
  progress: number;
  pageId: string | null;
  memoryIds: string[];
  fileName: string;
  filePath: string;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", filePath.slice(2));
  }
  return filePath;
}

function isPdfOrImage(mimeType: string, fileName: string): boolean {
  const mime = mimeType.toLowerCase();
  if (mime === "application/pdf" || mime.startsWith("image/")) {
    return true;
  }
  const ext = path.extname(fileName).toLowerCase();
  return [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"].includes(ext);
}

export async function uploadAttachmentToMemory(
  filePath: string,
  chatId: string,
  fileName: string,
  mimeType: string,
): Promise<AttachmentMemoryUploadResult | null> {
  if (!isPdfOrImage(mimeType, fileName)) {
    return null;
  }

  const resolvedPath = expandHome(filePath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new Error(`Attachment path is not a file: ${resolvedPath}`);
  }

  const client = await getPaprClient();
  const { buildAgentMemoryAddPolicy } = await import(
    "../utils/workspaceContextSchema.js"
  );
  const { paprMemoryScopeSpread } = await import("../utils/memoryScopeResolver.js");
  const addPolicy = await buildAgentMemoryAddPolicy({ client });
  const memoryScope = await paprMemoryScopeSpread({ chatId, addPolicy });

  const metadataPayload = {
    customMetadata: {
      file_name: fileName,
      chat_id: chatId,
      source: "paprwork_attachment",
    },
  };

  const response = await client.document.upload({
    file: createReadStream(resolvedPath),
    ...(memoryScope.user_id
      ? { user_id: memoryScope.user_id }
      : {}),
    ...(memoryScope.namespace_id ? { namespace_id: memoryScope.namespace_id } : {}),
    ...(memoryScope.policy
      ? { policy: JSON.stringify(memoryScope.policy) }
      : {}),
    metadata: JSON.stringify(metadataPayload),
  });

  const memoryItems = response.memory_items ?? response.memories ?? [];
  const uploadId = response.document_status?.upload_id ?? null;

  return {
    uploadId,
    status: response.status ?? response.document_status?.status_type ?? "processing",
    progress: response.document_status?.progress ?? 0,
    pageId: response.document_status?.page_id ?? null,
    memoryIds: memoryItems.map((item) => item.memoryId).filter(Boolean),
    fileName,
    filePath: resolvedPath,
  };
}
