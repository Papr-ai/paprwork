import { ipcMain } from "electron";
import fs from "fs/promises";
import path from "path";
import { resolvePaprUserDataPath } from "../../core/utils/paprWorkspace.js";

interface SaveChatAttachmentInput {
  chatId: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

interface SaveChatAttachmentResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

interface ReadChatAttachmentPreviewInput {
  filePath: string;
  mimeType?: string;
}

interface ReadChatAttachmentPreviewResult {
  success: boolean;
  dataUrl?: string;
  fileUrl?: string;
  error?: string;
}

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".ogg",
  ".mov",
]);

const VIDEO_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

function mimeTypeFromExtension(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized).replace(/#/g, "%23")}`;
  }
  return `file://${encodeURI(normalized).replace(/#/g, "%23")}`;
}

function resolvePreviewMimeType(filePath: string, mimeType?: string): string | null {
  if (mimeType?.startsWith("image/") || mimeType?.startsWith("video/")) {
    return mimeType;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return mimeTypeFromExtension(ext);
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    const videoMap: Record<string, string> = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".ogg": "video/ogg",
      ".mov": "video/quicktime",
    };
    return videoMap[ext] ?? "video/mp4";
  }
  return null;
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^\w.\-()+ ]/g, "_");
  return base.length > 0 ? base.slice(0, 180) : "attachment";
}

function extensionForMimeType(mimeType: string, fileName: string): string {
  const fromName = path.extname(fileName);
  if (fromName) return fromName;

  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
  };
  return map[mimeType] ?? "";
}

export function initializeChatAttachmentsIPC(): void {
  ipcMain.handle(
    "chat:save-attachment",
    async (
      _event,
      input: SaveChatAttachmentInput,
    ): Promise<SaveChatAttachmentResult> => {
      try {
        if (!input?.chatId || !input?.dataBase64) {
          return { success: false, error: "Missing chatId or file data" };
        }

        const safeChatId = input.chatId.replace(/[^\w-]/g, "_").slice(0, 64);
        const attachmentsRoot = path.join(
          resolvePaprUserDataPath(),
          "attachments",
          safeChatId,
        );
        await fs.mkdir(attachmentsRoot, { recursive: true });

        const safeName = sanitizeFileName(input.fileName || "attachment");
        const ext = extensionForMimeType(input.mimeType || "", safeName);
        const stem = ext && safeName.endsWith(ext)
          ? safeName.slice(0, -ext.length)
          : safeName.replace(/\.+$/, "");
        const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${stem}${ext}`;
        const filePath = path.join(attachmentsRoot, uniqueName);

        const buffer = Buffer.from(input.dataBase64, "base64");
        await fs.writeFile(filePath, buffer);

        return { success: true, filePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "chat:read-attachment-preview",
    async (
      _event,
      input: ReadChatAttachmentPreviewInput,
    ): Promise<ReadChatAttachmentPreviewResult> => {
      try {
        if (!input?.filePath) {
          return { success: false, error: "Missing filePath" };
        }

        const resolvedPath = path.resolve(input.filePath);
        const previewMime = resolvePreviewMimeType(resolvedPath, input.mimeType);
        if (!previewMime) {
          return {
            success: false,
            error: "Preview only supported for images and videos",
          };
        }

        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return { success: false, error: "Path is not a file" };
        }

        if (previewMime.startsWith("video/")) {
          if (stat.size > VIDEO_PREVIEW_MAX_BYTES) {
            return { success: false, error: "Video too large to preview" };
          }
          return { success: true, fileUrl: pathToFileUrl(resolvedPath) };
        }

        if (stat.size > PREVIEW_MAX_BYTES) {
          return { success: false, error: "Image too large to preview" };
        }

        const buffer = await fs.readFile(resolvedPath);
        const dataUrl = `data:${previewMime};base64,${buffer.toString("base64")}`;
        return { success: true, dataUrl };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
