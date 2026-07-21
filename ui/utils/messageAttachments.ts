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
  return `file://${filePath}`;
}
