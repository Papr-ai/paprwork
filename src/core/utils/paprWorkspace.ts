/**
 * Org/namespace workspace layout for Papr desktop.
 *
 * Layout:
 *   ~/Papr/
 *     .active-workspace.json
 *     orgs/{orgId}/namespaces/{namespaceId}/
 *       apps/ Jobs/ data/ workspace/ documents/ ...
 *
 * Runtime state (chats, code index) lives under:
 *   ~/.paprwork-v2/orgs/{orgId}/namespaces/{namespaceId}/
 */

import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";

export const ACTIVE_WORKSPACE_FILENAME = ".active-workspace.json";
export const LEGACY_MIGRATION_FILENAME = ".legacy-workspace-migration.json";

/** Bundled default mini-apps that may exist before legacy migration runs. */
export const DEFAULT_BUNDLED_APP_IDS = new Set([
  "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c",
]);

export interface ActiveWorkspacePointer {
  organizationId: string;
  organizationName?: string;
  namespaceId: string;
  namespaceName?: string;
  /** Absolute path to the active Papr workspace root (apps/Jobs/data). */
  paprHome: string;
  /** Absolute path to per-workspace Paprwork runtime data (chats.db, etc.). */
  userDataPath: string;
  activatedAt: string;
}

export interface LegacyWorkspaceMigrationRecord {
  migratedAt: string;
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
  movedPaths: string[];
  movedUserDataFiles?: string[];
}

export function getPaprBaseDir(): string {
  return path.join(os.homedir(), "Papr");
}

export function getPaprworkBaseDir(): string {
  return path.join(os.homedir(), ".paprwork-v2");
}

export function resolveOrgNamespaceWorkspacePath(
  organizationId: string,
  namespaceId: string,
): string {
  return path.join(
    getPaprBaseDir(),
    "orgs",
    organizationId,
    "namespaces",
    namespaceId,
  );
}

export function resolveOrgNamespaceUserDataPath(
  organizationId: string,
  namespaceId: string,
): string {
  return path.join(
    getPaprworkBaseDir(),
    "orgs",
    organizationId,
    "namespaces",
    namespaceId,
  );
}

export function getActiveWorkspacePointerPath(): string {
  return path.join(getPaprBaseDir(), ACTIVE_WORKSPACE_FILENAME);
}

export function getLegacyMigrationRecordPath(): string {
  return path.join(getPaprBaseDir(), LEGACY_MIGRATION_FILENAME);
}

export function readActiveWorkspacePointer(): ActiveWorkspacePointer | null {
  const pointerPath = getActiveWorkspacePointerPath();
  try {
    const raw = fs.readFileSync(pointerPath, "utf8");
    const parsed = JSON.parse(raw) as ActiveWorkspacePointer;
    if (
      !parsed.organizationId ||
      !parsed.namespaceId ||
      !parsed.paprHome ||
      !parsed.userDataPath
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeActiveWorkspacePointer(
  pointer: ActiveWorkspacePointer,
): Promise<void> {
  const pointerPath = getActiveWorkspacePointerPath();
  await fsPromises.mkdir(path.dirname(pointerPath), { recursive: true });
  await fsPromises.writeFile(pointerPath, JSON.stringify(pointer, null, 2), "utf8");
}

export async function ensureWorkspaceLayout(input: {
  organizationId: string;
  namespaceId: string;
  organizationName?: string;
  namespaceName?: string;
}): Promise<ActiveWorkspacePointer> {
  const paprHome = resolveOrgNamespaceWorkspacePath(
    input.organizationId,
    input.namespaceId,
  );
  const userDataPath = resolveOrgNamespaceUserDataPath(
    input.organizationId,
    input.namespaceId,
  );

  await fsPromises.mkdir(path.join(paprHome, "apps"), { recursive: true });
  await fsPromises.mkdir(path.join(paprHome, "Jobs"), { recursive: true });
  await fsPromises.mkdir(path.join(paprHome, "data"), { recursive: true });
  await fsPromises.mkdir(path.join(paprHome, "workspace"), { recursive: true });
  await fsPromises.mkdir(userDataPath, { recursive: true });

  const pointer: ActiveWorkspacePointer = {
    organizationId: input.organizationId,
    organizationName: input.organizationName,
    namespaceId: input.namespaceId,
    namespaceName: input.namespaceName,
    paprHome,
    userDataPath,
    activatedAt: new Date().toISOString(),
  };

  await writeActiveWorkspacePointer(pointer);
  return pointer;
}

const LEGACY_TOP_LEVEL_DIRS = [
  "apps",
  "Jobs",
  "data",
  "workspace",
  "documents",
  "bundles",
  "Chats",
  "Artifacts",
] as const;

const LEGACY_USER_DATA_FILES = [
  "chats.db",
  "chats.db-wal",
  "chats.db-shm",
  "code-index.db",
  "code-schema-id.txt",
] as const;

const EMPTY_CHATS_DB_BYTES = 100_000;

function listVisibleEntries(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

function pathHasContents(dirPath: string): boolean {
  return listVisibleEntries(dirPath).length > 0;
}

function targetAcceptsLegacyMerge(
  targetPath: string,
  dirName: (typeof LEGACY_TOP_LEVEL_DIRS)[number],
): boolean {
  const entries = listVisibleEntries(targetPath);
  if (entries.length === 0) {
    return true;
  }
  if (dirName === "apps") {
    return entries.every((entry) => DEFAULT_BUNDLED_APP_IDS.has(entry));
  }
  if (dirName === "data") {
    return entries.every((entry) =>
      ["apps.json", "jobs.json", "job-graph.json", "plans.db"].includes(entry),
    );
  }
  return false;
}

function readLegacyMigrationRecord(): LegacyWorkspaceMigrationRecord | null {
  try {
    const raw = fs.readFileSync(getLegacyMigrationRecordPath(), "utf8");
    return JSON.parse(raw) as LegacyWorkspaceMigrationRecord;
  } catch {
    return null;
  }
}

async function removeDirIfEmpty(dirPath: string): Promise<void> {
  try {
    const entries = await fsPromises.readdir(dirPath);
    const visible = entries.filter((entry) => !entry.startsWith("."));
    if (visible.length === 0) {
      await fsPromises.rmdir(dirPath);
    }
  } catch {
    // missing or not empty
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fsPromises.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function shouldPreferLegacyFile(
  legacyFile: string,
  targetFile: string,
): Promise<boolean> {
  const legacySize = await fileSize(legacyFile);
  if (legacySize === 0) {
    return false;
  }
  const targetSize = await fileSize(targetFile);
  if (targetSize === 0) {
    return true;
  }
  return legacySize > targetSize;
}

async function mergeLegacyDirIntoTarget(
  legacyPath: string,
  targetPath: string,
): Promise<boolean> {
  await fsPromises.mkdir(targetPath, { recursive: true });
  const entries = await fsPromises.readdir(legacyPath);
  let movedAny = false;

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }

    const from = path.join(legacyPath, entry);
    const to = path.join(targetPath, entry);
    const fromStat = await fsPromises.stat(from);

    if (fromStat.isDirectory()) {
      try {
        await fsPromises.access(to);
        const nestedMoved = await mergeLegacyDirIntoTarget(from, to);
        movedAny = movedAny || nestedMoved;
        await removeDirIfEmpty(from);
      } catch {
        await fsPromises.rename(from, to);
        movedAny = true;
      }
      continue;
    }

    try {
      await fsPromises.access(to);
      if (await shouldPreferLegacyFile(from, to)) {
        await fsPromises.rename(from, to);
        movedAny = true;
      }
    } catch {
      await fsPromises.rename(from, to);
      movedAny = true;
    }
  }

  await removeDirIfEmpty(legacyPath);
  return movedAny;
}

async function migrateLegacyTopLevelDir(input: {
  dirName: (typeof LEGACY_TOP_LEVEL_DIRS)[number];
  baseDir: string;
  targetPaprHome: string;
}): Promise<boolean> {
  const legacyPath = path.join(input.baseDir, input.dirName);
  const targetPath = path.join(input.targetPaprHome, input.dirName);

  try {
    await fsPromises.access(legacyPath);
  } catch {
    return false;
  }
  if (!pathHasContents(legacyPath)) {
    return false;
  }

  if (!pathHasContents(targetPath)) {
    await removeDirIfEmpty(targetPath);
    await fsPromises.rename(legacyPath, targetPath);
    return true;
  }

  if (targetAcceptsLegacyMerge(targetPath, input.dirName)) {
    return mergeLegacyDirIntoTarget(legacyPath, targetPath);
  }

  return false;
}

async function relocateTopLevelDir(input: {
  dirName: (typeof LEGACY_TOP_LEVEL_DIRS)[number];
  sourcePaprHome: string;
  targetPaprHome: string;
}): Promise<boolean> {
  if (input.sourcePaprHome === input.targetPaprHome) {
    return false;
  }

  const sourcePath = path.join(input.sourcePaprHome, input.dirName);
  const targetPath = path.join(input.targetPaprHome, input.dirName);

  try {
    await fsPromises.access(sourcePath);
  } catch {
    return false;
  }
  if (!pathHasContents(sourcePath)) {
    return false;
  }

  if (!pathHasContents(targetPath)) {
    await removeDirIfEmpty(targetPath);
    await fsPromises.rename(sourcePath, targetPath);
    return true;
  }

  if (targetAcceptsLegacyMerge(targetPath, input.dirName)) {
    return mergeLegacyDirIntoTarget(sourcePath, targetPath);
  }

  return false;
}

async function listOrgNamespaceWorkspacePaths(): Promise<string[]> {
  const orgsRoot = path.join(getPaprBaseDir(), "orgs");
  const workspacePaths: string[] = [];

  let orgIds: string[] = [];
  try {
    orgIds = await fsPromises.readdir(orgsRoot);
  } catch {
    return workspacePaths;
  }

  for (const orgId of orgIds) {
    if (orgId.startsWith(".")) {
      continue;
    }
    const namespacesRoot = path.join(orgsRoot, orgId, "namespaces");
    let namespaceIds: string[] = [];
    try {
      namespaceIds = await fsPromises.readdir(namespacesRoot);
    } catch {
      continue;
    }
    for (const namespaceId of namespaceIds) {
      if (namespaceId.startsWith(".")) {
        continue;
      }
      workspacePaths.push(path.join(namespacesRoot, namespaceId));
    }
  }

  return workspacePaths;
}

/**
 * Consolidate Papr folders that landed under the wrong org/namespace workspace
 * (e.g. workspace org "development") into the active canonical namespace.
 */
export async function relocateMisplacedNamespaceContent(input: {
  targetPaprHome: string;
}): Promise<{ relocatedPaths: string[]; sourceHomes: string[] } | null> {
  const targetHome = path.normalize(input.targetPaprHome);
  const relocatedPathSet = new Set<string>();
  const sourceHomeSet = new Set<string>();

  for (const sourceHome of await listOrgNamespaceWorkspacePaths()) {
    if (path.normalize(sourceHome) === targetHome) {
      continue;
    }

    for (const dirName of LEGACY_TOP_LEVEL_DIRS) {
      const relocated = await relocateTopLevelDir({
        dirName,
        sourcePaprHome: sourceHome,
        targetPaprHome: targetHome,
      });
      if (!relocated) {
        continue;
      }
      relocatedPathSet.add(dirName);
      sourceHomeSet.add(sourceHome);
    }
  }

  if (relocatedPathSet.size === 0) {
    return null;
  }

  return {
    relocatedPaths: [...relocatedPathSet],
    sourceHomes: [...sourceHomeSet],
  };
}

/**
 * Move legacy data that was migrated into the wrong org/namespace workspace
 * into the currently activating workspace.
 */
export async function relocateMisplacedLegacyMigration(input: {
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
  targetUserDataPath: string;
}): Promise<{ relocatedPaths: string[]; relocatedUserDataFiles: string[] } | null> {
  const record = readLegacyMigrationRecord();
  if (!record?.targetPaprHome) {
    return null;
  }

  const sameTarget =
    record.targetPaprHome === input.targetPaprHome &&
    record.organizationId === input.organizationId &&
    record.namespaceId === input.namespaceId;
  if (sameTarget) {
    return null;
  }

  const relocatedPaths: string[] = [];
  for (const dirName of record.movedPaths ?? []) {
    if (!(LEGACY_TOP_LEVEL_DIRS as readonly string[]).includes(dirName)) {
      continue;
    }
    const relocated = await relocateTopLevelDir({
      dirName: dirName as (typeof LEGACY_TOP_LEVEL_DIRS)[number],
      sourcePaprHome: record.targetPaprHome,
      targetPaprHome: input.targetPaprHome,
    });
    if (relocated) {
      relocatedPaths.push(dirName);
    }
  }

  const relocatedUserDataFiles: string[] = [];
  const sourceUserDataPath = resolveOrgNamespaceUserDataPath(
    record.organizationId,
    record.namespaceId,
  );
  if (sourceUserDataPath !== input.targetUserDataPath) {
    await fsPromises.mkdir(input.targetUserDataPath, { recursive: true });
    for (const fileName of record.movedUserDataFiles ?? []) {
      const sourcePath = path.join(sourceUserDataPath, fileName);
      const targetPath = path.join(input.targetUserDataPath, fileName);

      try {
        await fsPromises.access(sourcePath);
      } catch {
        continue;
      }

      if (fileName.startsWith("chats.db")) {
        const targetMainDb = path.join(input.targetUserDataPath, "chats.db");
        const targetSize = await fileSize(targetMainDb);
        if (targetSize >= EMPTY_CHATS_DB_BYTES) {
          continue;
        }
        if (fileName === "chats.db" && targetSize > 0) {
          await fsPromises.unlink(targetPath).catch(() => undefined);
        }
      } else {
        try {
          await fsPromises.access(targetPath);
          continue;
        } catch {
          // target missing — safe to move
        }
      }

      await fsPromises.rename(sourcePath, targetPath);
      relocatedUserDataFiles.push(fileName);
    }
  }

  if (relocatedPaths.length === 0 && relocatedUserDataFiles.length === 0) {
    return null;
  }

  const updatedRecord: LegacyWorkspaceMigrationRecord = {
    migratedAt: new Date().toISOString(),
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    targetPaprHome: input.targetPaprHome,
    movedPaths: [...new Set([...(record.movedPaths ?? []), ...relocatedPaths])],
    movedUserDataFiles: [
      ...new Set([...(record.movedUserDataFiles ?? []), ...relocatedUserDataFiles]),
    ],
  };
  await fsPromises.mkdir(getPaprBaseDir(), { recursive: true });
  await fsPromises.writeFile(
    getLegacyMigrationRecordPath(),
    JSON.stringify(updatedRecord, null, 2),
    "utf8",
  );

  return { relocatedPaths, relocatedUserDataFiles };
}

/**
 * Move flat ~/Papr/{apps,Jobs,data,...} into the active org/namespace workspace once.
 * Idempotent per directory — resumes partial migrations. Merges into targets that only
 * contain bundled default apps or empty scaffold files.
 */
export async function migrateLegacyFlatPaprLayout(input: {
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
}): Promise<LegacyWorkspaceMigrationRecord | null> {
  const baseDir = getPaprBaseDir();
  const existingRecord = readLegacyMigrationRecord();
  const movedSet = new Set(existingRecord?.movedPaths ?? []);
  const newlyMoved: string[] = [];

  for (const dirName of LEGACY_TOP_LEVEL_DIRS) {
    if (movedSet.has(dirName)) {
      continue;
    }

    const migrated = await migrateLegacyTopLevelDir({
      dirName,
      baseDir,
      targetPaprHome: input.targetPaprHome,
    });
    if (!migrated) {
      continue;
    }

    movedSet.add(dirName);
    newlyMoved.push(dirName);
  }

  if (newlyMoved.length === 0) {
    return null;
  }

  const record: LegacyWorkspaceMigrationRecord = {
    migratedAt: new Date().toISOString(),
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    targetPaprHome: input.targetPaprHome,
    movedPaths: [...movedSet],
  };
  await fsPromises.writeFile(
    getLegacyMigrationRecordPath(),
    JSON.stringify(record, null, 2),
    "utf8",
  );
  return record;
}

/**
 * Move legacy global ~/.paprwork-v2 runtime files into the active workspace once.
 * Primarily chats.db (multi-GB) and code-index metadata.
 */
export async function migrateLegacyUserDataRuntime(input: {
  organizationId: string;
  namespaceId: string;
  targetUserDataPath: string;
  targetPaprHome: string;
}): Promise<string[] | null> {
  const legacyBase = getPaprworkBaseDir();
  await fsPromises.mkdir(input.targetUserDataPath, { recursive: true });

  const existingRecord = readLegacyMigrationRecord();
  const movedSet = new Set(existingRecord?.movedUserDataFiles ?? []);
  const newlyMoved: string[] = [];

  for (const fileName of LEGACY_USER_DATA_FILES) {
    if (movedSet.has(fileName)) {
      continue;
    }

    const legacyPath = path.join(legacyBase, fileName);
    const targetPath = path.join(input.targetUserDataPath, fileName);

    try {
      await fsPromises.access(legacyPath);
    } catch {
      continue;
    }

    if (fileName.startsWith("chats.db")) {
      const targetMainDb = path.join(input.targetUserDataPath, "chats.db");
      const targetSize = await fileSize(targetMainDb);
      if (targetSize >= EMPTY_CHATS_DB_BYTES) {
        continue;
      }
      if (fileName === "chats.db" && targetSize > 0) {
        await fsPromises.unlink(targetPath).catch(() => undefined);
      }
    } else {
      try {
        await fsPromises.access(targetPath);
        continue;
      } catch {
        // target missing — safe to move
      }
    }

    await fsPromises.rename(legacyPath, targetPath);
    movedSet.add(fileName);
    newlyMoved.push(fileName);
  }

  if (newlyMoved.length === 0) {
    return null;
  }

  const record: LegacyWorkspaceMigrationRecord = {
    migratedAt: new Date().toISOString(),
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    targetPaprHome: input.targetPaprHome,
    movedPaths: existingRecord?.movedPaths ?? [],
    movedUserDataFiles: [...movedSet],
  };
  await fsPromises.mkdir(getPaprBaseDir(), { recursive: true });
  await fsPromises.writeFile(
    getLegacyMigrationRecordPath(),
    JSON.stringify(record, null, 2),
    "utf8",
  );
  return newlyMoved;
}

export function applyActiveWorkspaceEnv(pointer: ActiveWorkspacePointer): void {
  process.env.PAPR_HOME = pointer.paprHome;
  process.env.PAPR_USER_DATA = pointer.userDataPath;
  process.env.PAPR_ORG_ID = pointer.organizationId;
  process.env.PAPR_NAMESPACE_ID = pointer.namespaceId;
}

export function clearActiveWorkspaceEnv(): void {
  delete process.env.PAPR_HOME;
  delete process.env.PAPR_USER_DATA;
  delete process.env.PAPR_ORG_ID;
  delete process.env.PAPR_NAMESPACE_ID;
}

export function resolvePaprUserDataPath(): string {
  const fromEnv = process.env.PAPR_USER_DATA?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const pointer = readActiveWorkspacePointer();
  if (pointer?.userDataPath) {
    return pointer.userDataPath;
  }
  return getPaprworkBaseDir();
}
