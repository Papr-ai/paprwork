/**
 * Build chat "file" context artifacts (local disk path for read_file).
 * Shared by context picker upload and drag-and-drop.
 */

import type { Artifact } from "../stores/artifactsStore";

/**
 * Resolve a dropped/picked file to its location on disk.
 *
 * `File.path` was removed in Electron 32, so reading it alone always fell
 * through to `file.name` — never an absolute path — which forced every
 * attachment through a base64 copy over IPC. webUtils is asked first; the
 * legacy field is kept for any host that still populates it, and the name
 * remains the last resort so callers keep a label to show.
 */
export function getElectronFilePath(file: File): string {
  const fromWebUtils = window.electronAPI?.files?.getPathForFile?.(file);
  if (typeof fromWebUtils === "string" && fromWebUtils.length > 0) {
    return fromWebUtils;
  }

  const legacy = (file as File & { path?: string }).path;
  return typeof legacy === "string" && legacy.length > 0 ? legacy : file.name;
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
