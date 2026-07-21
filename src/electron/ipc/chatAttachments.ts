import { ipcMain } from "electron";
import fs from "fs/promises";
import os from "os";
import path from "path";

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
          os.homedir(),
          ".paprwork-v2",
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
}
