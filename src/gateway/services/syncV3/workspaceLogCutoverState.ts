/**
 * Per-replica workspace log genesis cutover markers (Phase 3).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";

const CUTOVER_FILENAME = "workspace-log-cutover.json";

export interface WorkspaceLogCutoverRecord {
  replicaId: string;
  snapshotHash: string;
  tableCount: number;
  genesisSeq: number;
  cutoverAt: string;
}

export interface WorkspaceLogCutoverFile {
  version: 1;
  updatedAt: string;
  replicas: Record<string, WorkspaceLogCutoverRecord>;
}

function cutoverPath(): string {
  return path.join(getPaprRoot(), "data", CUTOVER_FILENAME);
}

function emptyFile(): WorkspaceLogCutoverFile {
  return { version: 1, updatedAt: new Date(0).toISOString(), replicas: {} };
}

export async function readWorkspaceLogCutoverState(): Promise<WorkspaceLogCutoverFile> {
  try {
    const raw = await fs.readFile(cutoverPath(), "utf8");
    const parsed = JSON.parse(raw) as WorkspaceLogCutoverFile;
    if (parsed.version !== 1 || typeof parsed.replicas !== "object") {
      return emptyFile();
    }
    return parsed;
  } catch {
    return emptyFile();
  }
}

export async function getWorkspaceLogCutoverRecord(
  replicaId: string,
): Promise<WorkspaceLogCutoverRecord | null> {
  const file = await readWorkspaceLogCutoverState();
  return file.replicas[replicaId] ?? null;
}

export async function markWorkspaceLogGenesisComplete(
  record: WorkspaceLogCutoverRecord,
): Promise<void> {
  const file = await readWorkspaceLogCutoverState();
  file.replicas[record.replicaId] = record;
  file.updatedAt = new Date().toISOString();
  const filePath = cutoverPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(file, null, 2), "utf8");
}

export async function clearWorkspaceLogCutoverStateForTests(): Promise<void> {
  try {
    await fs.unlink(cutoverPath());
  } catch {
    /* missing */
  }
}
