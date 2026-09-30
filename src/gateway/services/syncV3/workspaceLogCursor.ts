/**
 * Persisted materialization cursor per Turso replica (Phase 3).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";

const CURSOR_FILENAME = "workspace-log-cursors.json";

export interface WorkspaceLogCursorFile {
  version: 1;
  updatedAt: string;
  /** replicaId (Turso short name) → last applied seq */
  replicas: Record<string, number>;
}

function cursorPath(): string {
  return path.join(getPaprRoot(), "data", CURSOR_FILENAME);
}

function emptyFile(): WorkspaceLogCursorFile {
  return { version: 1, updatedAt: new Date(0).toISOString(), replicas: {} };
}

export async function readWorkspaceLogCursors(): Promise<WorkspaceLogCursorFile> {
  try {
    const raw = await fs.readFile(cursorPath(), "utf8");
    const parsed = JSON.parse(raw) as WorkspaceLogCursorFile;
    if (parsed.version !== 1 || typeof parsed.replicas !== "object") {
      return emptyFile();
    }
    return parsed;
  } catch {
    return emptyFile();
  }
}

export async function getWorkspaceLogCursor(replicaId: string): Promise<number> {
  const file = await readWorkspaceLogCursors();
  return file.replicas[replicaId] ?? 0;
}

export async function setWorkspaceLogCursor(
  replicaId: string,
  seq: number,
): Promise<void> {
  const file = await readWorkspaceLogCursors();
  file.replicas[replicaId] = seq;
  file.updatedAt = new Date().toISOString();
  const filePath = cursorPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(file, null, 2), "utf8");
}

export async function clearWorkspaceLogCursorsForTests(): Promise<void> {
  try {
    await fs.unlink(cursorPath());
  } catch {
    /* missing */
  }
}
