import type { Artifact } from "../stores/artifactsStore";
import type { MessageAttachment } from "../types/chat";

export function artifactsToMessageAttachments(
  artifacts: Artifact[],
): MessageAttachment[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifact.title,
    kind: artifact.type,
    mimeType:
      typeof artifact.metadata?.fileType === "string"
        ? artifact.metadata.fileType
        : undefined,
    filePath:
      typeof artifact.metadata?.filePath === "string"
        ? artifact.metadata.filePath
        : undefined,
  }));
}

export function attachmentKindLabel(attachment: MessageAttachment): string {
  if (attachment.mimeType === "application/pdf") return "PDF";
  if (attachment.mimeType?.startsWith("image/")) return "Image";
  if (attachment.kind === "document") return "Document";
  if (attachment.kind === "app") return "App";
  return "File";
}

export function isImageAttachment(attachment: MessageAttachment): boolean {
  return (
    attachment.mimeType?.startsWith("image/") === true ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.name)
  );
}

export function attachmentFileSrc(filePath: string): string {
  if (filePath.startsWith("file://")) return filePath;
  if (filePath.startsWith("data:")) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized).replace(/#/g, "%23")}`;
  }
  return `file://${encodeURI(normalized).replace(/#/g, "%23")}`;
}

export function buildAttachmentPreviewDataUrl(
  mimeType: string,
  dataBase64: string,
): string {
  return `data:${mimeType};base64,${dataBase64}`;
}

export async function loadAttachmentPreviewSrc(
  filePath: string,
  mimeType?: string,
): Promise<string | null> {
  const readPreview = window.electronAPI?.chatAttachments?.readPreview;
  if (readPreview) {
    const result = await readPreview({ filePath, mimeType });
    if (result.success && result.dataUrl) {
      return result.dataUrl;
    }
    return null;
  }

  // Non-Electron fallback (e.g. dev in browser) — may be blocked by web security.
  return attachmentFileSrc(filePath);
}
