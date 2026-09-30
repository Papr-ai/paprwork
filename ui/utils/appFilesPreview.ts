/** Preview classification for App Files. Keep this pure so MIME/extension
 * fallbacks are unit tested independently from React and the gateway. */

import type { AppFileRow } from "../../src/gateway/services/appFiles/appFilesSchema";

export type AppFilePreviewKind = "audio" | "image" | "pdf" | "text" | "video" | "unsupported";

const TEXT_EXTENSIONS = new Set([
  "csv", "json", "log", "md", "rtf", "text", "toml", "tsv", "txt", "xml", "yaml", "yml",
]);

export function previewKind(file: Pick<AppFileRow, "file_name" | "mime">): AppFilePreviewKind {
  const mime = (file.mime ?? "").toLowerCase();
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) return "text";
  if (mime.startsWith("video/")) return "video";

  const extension = file.file_name.toLowerCase().split(".").pop() ?? "";
  if (["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"].includes(extension)) return "audio";
  if (["avif", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (["m4v", "mkv", "mov", "mp4", "webm"].includes(extension)) return "video";
  return "unsupported";
}

export function canPreviewAppFile(file: Pick<AppFileRow, "file_name" | "mime">): boolean {
  return previewKind(file) !== "unsupported";
}
