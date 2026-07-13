/**
 * Resolve chat attachment files to absolute disk paths (Electron drag/drop, paste, picker).
 */

import type { Artifact } from "../stores/artifactsStore";
import {
  createFileContextArtifact,
  getElectronFilePath,
} from "./fileContextArtifact";

const SUPPORTED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
]);

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".tif",
  ".tiff",
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".css",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".sh",
  ".sql",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
]);

export interface ResolvedAttachmentFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

export function isAbsoluteFilePath(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.startsWith("/")) return true;
  return /^[a-zA-Z]:[\\/]/.test(filePath);
}

export function isSupportedAttachmentFile(file: File): boolean {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("image/") || SUPPORTED_ATTACHMENT_TYPES.has(mime)) {
    return true;
  }

  const ext = getExtension(file.name);
  return SUPPORTED_ATTACHMENT_EXTENSIONS.has(ext);
}

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

function mimeToExtension(mimeType: string): string {
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

function defaultNameForFile(file: File, index: number): string {
  const trimmed = file.name?.trim();
  if (trimmed && trimmed !== "blob") return trimmed;

  const ext = mimeToExtension(file.type) || getExtension(trimmed);
  const base =
    file.type.startsWith("image/") ? "pasted-image"
    : file.type === "application/pdf" ? "pasted-document"
    : "pasted-file";
  return `${base}-${index + 1}${ext || ""}`;
}

export function extractFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const fromList = Array.from(dataTransfer.files ?? []);
  if (fromList.length > 0) {
    return fromList.filter(isSupportedAttachmentFile);
  }

  const fromItems: File[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isSupportedAttachmentFile(file)) {
      fromItems.push(file);
    }
  }
  return fromItems;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function persistAttachmentFile(
  file: File,
  chatId: string,
  index: number,
): Promise<ResolvedAttachmentFile | null> {
  const api = window.electronAPI?.chatAttachments?.save;
  if (!api) {
    console.warn("[chatAttachmentFiles] chatAttachments.save API unavailable");
    return null;
  }

  const fileName = defaultNameForFile(file, index);
  const result = await api({
    chatId,
    fileName,
    mimeType: file.type || "application/octet-stream",
    dataBase64: await fileToBase64(file),
  });

  if (!result.success || !result.filePath) {
    console.warn("[chatAttachmentFiles] Failed to save attachment:", result.error);
    return null;
  }

  return {
    name: fileName,
    path: result.filePath,
    size: file.size,
    type: file.type || "application/octet-stream",
  };
}

export async function resolveAttachmentFiles(
  files: File[],
  chatId: string,
): Promise<ResolvedAttachmentFile[]> {
  const supported = files.filter(isSupportedAttachmentFile);
  const resolved: ResolvedAttachmentFile[] = [];

  for (let i = 0; i < supported.length; i++) {
    const file = supported[i];
    const existingPath = getElectronFilePath(file);

    if (isAbsoluteFilePath(existingPath)) {
      resolved.push({
        name: file.name || defaultNameForFile(file, i),
        path: existingPath,
        size: file.size,
        type: file.type || "application/octet-stream",
      });
      continue;
    }

    const saved = await persistAttachmentFile(file, chatId, i);
    if (saved) resolved.push(saved);
  }

  return resolved;
}

export function createArtifactsFromResolvedFiles(
  files: ResolvedAttachmentFile[],
): Artifact[] {
  const t = Date.now();
  return files.map((file, i) => {
    const pseudoFile = {
      name: file.name,
      size: file.size,
      type: file.type,
    } as File;
    return createFileContextArtifact(pseudoFile, `${t}-${i}`, file.path);
  });
}

export async function createArtifactsFromIncomingFiles(
  files: File[],
  chatId: string,
): Promise<Artifact[]> {
  const resolved = await resolveAttachmentFiles(files, chatId);
  return createArtifactsFromResolvedFiles(resolved);
}
