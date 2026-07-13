/**
 * Build chat "file" context artifacts (local disk path for read_file).
 * Shared by context picker upload and drag-and-drop.
 */

import type { Artifact } from "../stores/artifactsStore";

export function getElectronFilePath(file: File): string {
  const p = (file as File & { path?: string }).path;
  return typeof p === "string" && p.length > 0 ? p : file.name;
}

export function createFileContextArtifact(
  file: File,
  uniqueId: string,
  filePathOverride?: string,
): Artifact {
  const filePath = filePathOverride ?? getElectronFilePath(file);
  return {
    id: `file-${uniqueId}`,
    title: file.name,
    type: "file",
    content: `File path: ${filePath}`,
    tags: ["file-upload"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      filePath,
      fileSize: file.size,
      fileType: file.type || "unknown",
    },
  };
}

export function createFileContextArtifactsFromFiles(files: File[]): Artifact[] {
  const t = Date.now();
  return files.map((file, i) => createFileContextArtifact(file, `${t}-${i}`));
}
