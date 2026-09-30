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
  // Data and office formats. An attachment is handed to the agent as a path,
  // which it opens with read_file or bash, so breadth here costs nothing and
  // these are the drops users reach for most after images and PDFs.
  ".csv",
  ".tsv",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".rtf",
  ".odt",
  ".ods",
  ".odp",
  ".ipynb",
  // Text and configuration.
  ".log",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".properties",
  ".jsonl",
  // Further source languages.
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".scss",
  ".sass",
  ".less",
  ".cs",
  ".scala",
  ".lua",
  ".pl",
  ".dart",
  ".ex",
  ".exs",
  ".r",
  // Archives — the agent can unpack these with bash.
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  // Media. The attachment preview IPC already handles these.
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".heic",
  ".heif",
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

/**
 * Every file in the drop or paste, with no filtering.
 *
 * This deliberately does not decide what is attachable. Filtering here is what
 * made an unsupported drop indistinguishable from a broken feature: each call
 * site received an empty array and returned without a word. Callers read
 * everything, then run `classifyAttachmentFiles` so the rejected files can be
 * named. A paste carrying only text yields an empty array, which is how a
 * caller knows to leave the event alone.
 */
export function readIncomingFiles(source: DataTransfer): File[] {
  const fromList = Array.from(source.files ?? []);
  if (fromList.length > 0) return fromList;

  const fromItems: File[] = [];
  for (const item of Array.from(source.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

export interface ClassifiedAttachments {
  accepted: File[];
  rejected: File[];
}

export function classifyAttachmentFiles(files: File[]): ClassifiedAttachments {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) {
    (isSupportedAttachmentFile(file) ? accepted : rejected).push(file);
  }
  return { accepted, rejected };
}

/**
 * Wording for files the allowlist turned away, or null when there is nothing
 * to report. Names the files, because "unsupported file type" leaves the user
 * guessing which of several dropped files was the problem.
 */
export function describeRejectedAttachments(rejected: File[]): string | null {
  if (rejected.length === 0) return null;

  const named = rejected
    .slice(0, 3)
    .map((file) => file.name || "unnamed file")
    .join(", ");
  const remainder = rejected.length - Math.min(rejected.length, 3);
  const suffix = remainder > 0 ? ` and ${remainder} more` : "";

  return rejected.length === 1
    ? `Can't attach ${named} — that file type isn't supported yet.`
    : `Can't attach ${named}${suffix} — those file types aren't supported yet.`;
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
