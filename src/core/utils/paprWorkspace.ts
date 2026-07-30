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
  /** User confirmed the one-time flat ~/Papr → namespace move in the UI. */
  userConsentMigrationAt?: string;
  /** Top-level ~/Papr entries moved during consent migration (includes non-canonical clutter). */
  movedRootEntries?: string[];
}

/** Kept at ~/Papr root — not moved into org/namespace workspaces. */
export const PAPR_ROOT_RESERVED_ENTRIES = new Set(["orgs", "stripe-project"]);

/**
 * Desktop-global files under ~/Papr/data — not per-namespace workspace data.
 * paprWorkspaceCache.ts and paprLogin.ts write these at the Papr root intentionally.
 */
export const PAPR_ROOT_GLOBAL_DATA_FILENAMES = new Set([
  "papr-workspace-cache.json",
  "papr-auth-pkce.json",
]);

export interface LegacyFlatPaprDetection {
  needsUserConsent: boolean;
  entries: string[];
}

export interface UserConsentMigrationResult {
  movedEntries: string[];
  userDataFiles: string[] | null;
  targetPaprHome: string;
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
  await fsPromises.mkdir(path.join(paprHome, "documents"), { recursive: true });
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

/** Flat ~/Papr folder names that map into the namespace workspace layout. */
const CONSENT_CANONICAL_ROOT_DIRS = new Set<string>([
  ...LEGACY_TOP_LEVEL_DIRS,
  "jobs",
  "databases",
  "backups",
]);

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

/** True when ~/Papr/data only holds desktop-global cache/auth (not workspace data). */
export function isPaprRootGlobalDataDir(dataDirPath: string): boolean {
  const entries = listVisibleEntries(dataDirPath);
  if (entries.length === 0) {
    return false;
  }
  return entries.every((entry) => PAPR_ROOT_GLOBAL_DATA_FILENAMES.has(entry));
}

function isIgnorableFlatPaprRootEntry(baseDir: string, entry: string): boolean {
  if (PAPR_ROOT_RESERVED_ENTRIES.has(entry)) {
    return true;
  }
  if (entry === "data") {
    return isPaprRootGlobalDataDir(path.join(baseDir, "data"));
  }
  return false;
}

async function appDirHasIndexHtml(appDir: string): Promise<boolean> {
  try {
    await fsPromises.access(path.join(appDir, "index.html"));
    return true;
  } catch {
    return false;
  }
}

/** True when the folder is bundled default or a registry scaffold without source files. */
async function appDirAcceptsLegacyMerge(appDir: string, appId: string): Promise<boolean> {
  if (DEFAULT_BUNDLED_APP_IDS.has(appId)) {
    return true;
  }
  return !(await appDirHasIndexHtml(appDir));
}

async function targetAcceptsLegacyMerge(
  targetPath: string,
  dirName: (typeof LEGACY_TOP_LEVEL_DIRS)[number],
): Promise<boolean> {
  const entries = listVisibleEntries(targetPath);
  if (entries.length === 0) {
    return true;
  }
  if (dirName === "apps") {
    for (const entry of entries) {
      if (!(await appDirAcceptsLegacyMerge(path.join(targetPath, entry), entry))) {
        return false;
      }
    }
    return true;
  }
  if (dirName === "data") {
    return entries.every((entry) =>
      ["apps.json", "jobs.json", "job-graph.json", "plans.db"].includes(entry),
    );
  }
  // Per-item merge is safe for documents and other artifact trees.
  if (
    dirName === "documents" ||
    dirName === "bundles" ||
    dirName === "Chats" ||
    dirName === "Artifacts"
  ) {
    return true;
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

async function fileMtimeMs(filePath: string): Promise<number> {
  try {
    const stat = await fsPromises.stat(filePath);
    return stat.mtimeMs;
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

  const legacyMtime = await fileMtimeMs(legacyFile);
  const targetMtime = await fileMtimeMs(targetFile);
  if (legacyMtime !== targetMtime) {
    return legacyMtime > targetMtime;
  }

  return legacySize > targetSize;
}

async function mergeLegacyDirIntoTarget(
  legacyPath: string,
  targetPath: string,
  options?: { skipFilenames?: ReadonlySet<string> },
): Promise<boolean> {
  await fsPromises.mkdir(targetPath, { recursive: true });
  const entries = await fsPromises.readdir(legacyPath);
  let movedAny = false;

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    if (options?.skipFilenames?.has(entry)) {
      continue;
    }

    const from = path.join(legacyPath, entry);
    const to = path.join(targetPath, entry);
    let fromStat;
    try {
      fromStat = await fsPromises.stat(from);
    } catch {
      continue;
    }

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
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.rename(legacyPath, targetPath);
    return true;
  }

  if (await targetAcceptsLegacyMerge(targetPath, input.dirName)) {
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    return mergeLegacyDirIntoTarget(legacyPath, targetPath);
  }

  return false;
}

/** Merge app folders individually so one complete app does not block the rest. */
async function mergeAppsDirFromSource(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  await fsPromises.mkdir(targetPath, { recursive: true });
  let movedAny = false;

  for (const entry of listVisibleEntries(sourcePath)) {
    const sourceAppDir = path.join(sourcePath, entry);
    let sourceStat;
    try {
      sourceStat = await fsPromises.stat(sourceAppDir);
    } catch {
      continue;
    }
    if (!sourceStat.isDirectory()) {
      continue;
    }
    if (!(await appDirHasIndexHtml(sourceAppDir))) {
      continue;
    }

    const targetAppDir = path.join(targetPath, entry);
    try {
      await fsPromises.access(targetAppDir);
      if (!(await appDirAcceptsLegacyMerge(targetAppDir, entry))) {
        continue;
      }
    } catch {
      /* target app dir missing — merge will create it */
    }

    const merged = await mergeLegacyDirIntoTarget(sourceAppDir, targetAppDir);
    movedAny = movedAny || merged;
  }

  return movedAny;
}

/** Per-job merge — one populated job folder must not block others. */
async function mergeJobsDirFromSourceForce(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  await fsPromises.mkdir(targetPath, { recursive: true });
  let movedAny = false;

  for (const entry of listVisibleEntries(sourcePath)) {
    const sourceJobDir = path.join(sourcePath, entry);
    let sourceStat;
    try {
      sourceStat = await fsPromises.stat(sourceJobDir);
    } catch {
      continue;
    }
    if (!sourceStat.isDirectory()) {
      continue;
    }

    const targetJobDir = path.join(targetPath, entry);
    const merged = await mergeLegacyDirIntoTarget(sourceJobDir, targetJobDir);
    movedAny = movedAny || merged;
  }

  return movedAny;
}

/** Consent migration merges every app folder (legacy content wins over scaffolds). */
async function mergeAppsDirFromSourceForce(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  await fsPromises.mkdir(targetPath, { recursive: true });
  let movedAny = false;

  for (const entry of listVisibleEntries(sourcePath)) {
    const sourceAppDir = path.join(sourcePath, entry);
    let sourceStat;
    try {
      sourceStat = await fsPromises.stat(sourceAppDir);
    } catch {
      continue;
    }
    if (!sourceStat.isDirectory()) {
      continue;
    }

    const targetAppDir = path.join(targetPath, entry);
    const merged = await mergeLegacyDirIntoTarget(sourceAppDir, targetAppDir);
    movedAny = movedAny || merged;
  }

  return movedAny;
}

async function migrateConsentCanonicalDir(input: {
  entryName: string;
  baseDir: string;
  targetPaprHome: string;
}): Promise<boolean> {
  const targetDirName =
    input.entryName === "jobs" ? "Jobs" : input.entryName;
  const legacyPath = path.join(input.baseDir, input.entryName);
  const targetPath = path.join(input.targetPaprHome, targetDirName);

  try {
    await fsPromises.access(legacyPath);
  } catch {
    return false;
  }
  if (!pathHasContents(legacyPath)) {
    await removeDirIfEmpty(legacyPath);
    return false;
  }

  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });

  if (!pathHasContents(targetPath)) {
    await removeDirIfEmpty(targetPath);
    await fsPromises.rename(legacyPath, targetPath);
    return true;
  }

  if (targetDirName === "apps") {
    return mergeAppsDirFromSourceForce(legacyPath, targetPath);
  }
  if (targetDirName === "Jobs") {
    return mergeJobsDirFromSourceForce(legacyPath, targetPath);
  }
  if (targetDirName === "data") {
    return mergeLegacyDirIntoTarget(legacyPath, targetPath, {
      skipFilenames: PAPR_ROOT_GLOBAL_DATA_FILENAMES,
    });
  }

  return mergeLegacyDirIntoTarget(legacyPath, targetPath);
}

async function migrateConsentMiscEntry(input: {
  entryName: string;
  baseDir: string;
  targetPaprHome: string;
}): Promise<boolean> {
  const sourcePath = path.join(input.baseDir, input.entryName);
  const targetPath = path.join(input.targetPaprHome, input.entryName);

  let sourceStat;
  try {
    sourceStat = await fsPromises.stat(sourcePath);
  } catch {
    return false;
  }

  await fsPromises.mkdir(input.targetPaprHome, { recursive: true });

  if (sourceStat.isDirectory()) {
    if (!pathHasContents(sourcePath)) {
      await removeDirIfEmpty(sourcePath);
      return false;
    }
    try {
      await fsPromises.access(targetPath);
      return mergeLegacyDirIntoTarget(sourcePath, targetPath);
    } catch {
      await fsPromises.rename(sourcePath, targetPath);
      return true;
    }
  }

  try {
    await fsPromises.access(targetPath);
    if (await shouldPreferLegacyFile(sourcePath, targetPath)) {
      await fsPromises.rename(sourcePath, targetPath);
      return true;
    }
    await fsPromises.unlink(sourcePath);
    return false;
  } catch {
    await fsPromises.rename(sourcePath, targetPath);
    return true;
  }
}

async function migrateConsentRootEntry(input: {
  entryName: string;
  baseDir: string;
  targetPaprHome: string;
}): Promise<boolean> {
  if (PAPR_ROOT_RESERVED_ENTRIES.has(input.entryName)) {
    return false;
  }

  if (CONSENT_CANONICAL_ROOT_DIRS.has(input.entryName)) {
    return migrateConsentCanonicalDir(input);
  }

  return migrateConsentMiscEntry(input);
}

/** Visible top-level ~/Papr entries that belong in an org/namespace workspace. */
export function listUnmigratedFlatPaprEntries(): string[] {
  const baseDir = getPaprBaseDir();
  return listVisibleEntries(baseDir).filter(
    (entry) => !isIgnorableFlatPaprRootEntry(baseDir, entry),
  );
}

export function detectUnmigratedFlatPaprContent(): boolean {
  return listUnmigratedFlatPaprEntries().length > 0;
}

async function writeLegacyMigrationRecordPartial(
  patch: Partial<LegacyWorkspaceMigrationRecord> &
    Pick<
      LegacyWorkspaceMigrationRecord,
      "organizationId" | "namespaceId" | "targetPaprHome"
    >,
): Promise<void> {
  const existing = readLegacyMigrationRecord();
  const record: LegacyWorkspaceMigrationRecord = {
    migratedAt: patch.migratedAt ?? new Date().toISOString(),
    organizationId: patch.organizationId,
    namespaceId: patch.namespaceId,
    targetPaprHome: patch.targetPaprHome,
    movedPaths: patch.movedPaths ?? existing?.movedPaths ?? [],
    movedUserDataFiles: patch.movedUserDataFiles ?? existing?.movedUserDataFiles,
    userConsentMigrationAt:
      patch.userConsentMigrationAt ?? existing?.userConsentMigrationAt,
    movedRootEntries: patch.movedRootEntries ?? existing?.movedRootEntries,
  };
  await fsPromises.mkdir(getPaprBaseDir(), { recursive: true });
  await fsPromises.writeFile(
    getLegacyMigrationRecordPath(),
    JSON.stringify(record, null, 2),
    "utf8",
  );
}

/** Mark consent complete when an older build already moved flat data (root is clean). */
export async function finalizeLegacyMigrationConsentIfClean(input: {
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
}): Promise<void> {
  const record = readLegacyMigrationRecord();
  if (record?.userConsentMigrationAt) {
    return;
  }
  if (detectUnmigratedFlatPaprContent()) {
    return;
  }

  await archiveStaleFlatRootGitRepo({ targetPaprHome: input.targetPaprHome });

  await writeLegacyMigrationRecordPartial({
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    targetPaprHome: input.targetPaprHome,
    userConsentMigrationAt: new Date().toISOString(),
  });
}

export async function detectLegacyFlatPaprMigrationNeed(input: {
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
}): Promise<LegacyFlatPaprDetection> {
  await finalizeLegacyMigrationConsentIfClean(input);
  const entries = listUnmigratedFlatPaprEntries();
  return {
    needsUserConsent: entries.length > 0,
    entries,
  };
}

/**
 * User-confirmed one-time move: everything at ~/Papr root (except orgs/ + reserved)
 * into the chosen org/namespace workspace. Legacy content wins on merge conflicts.
 */
export async function runUserConsentFlatPaprMigration(input: {
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
  targetUserDataPath: string;
}): Promise<UserConsentMigrationResult> {
  const baseDir = getPaprBaseDir();
  const movedEntries: string[] = [];

  for (const entry of listUnmigratedFlatPaprEntries()) {
    const moved = await migrateConsentRootEntry({
      entryName: entry,
      baseDir,
      targetPaprHome: input.targetPaprHome,
    });
    if (moved) {
      movedEntries.push(entry);
    }
  }

  const userDataFiles = await migrateLegacyUserDataRuntime({
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    targetPaprHome: input.targetPaprHome,
    targetUserDataPath: input.targetUserDataPath,
  });

  const existing = readLegacyMigrationRecord();
  await writeLegacyMigrationRecordPartial({
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    targetPaprHome: input.targetPaprHome,
    movedPaths: [...new Set([...(existing?.movedPaths ?? []), ...movedEntries])],
    movedUserDataFiles: userDataFiles
      ? [...new Set([...(existing?.movedUserDataFiles ?? []), ...userDataFiles])]
      : existing?.movedUserDataFiles,
    userConsentMigrationAt: new Date().toISOString(),
    movedRootEntries: movedEntries,
  });

  await archiveStaleFlatRootGitRepo({ targetPaprHome: input.targetPaprHome });

  return {
    movedEntries,
    userDataFiles,
    targetPaprHome: input.targetPaprHome,
  };
}

/**
 * Pre-org/namespace cloud sync cloned into flat ~/Papr/.git. Once the active workspace
 * has its own repo, rename the stale root git metadata so pulls cannot restore flat Jobs/.
 */
export async function archiveStaleFlatRootGitRepo(input: {
  targetPaprHome: string;
}): Promise<{ archivedGitDir: string | null; archivedSyncState: boolean }> {
  const baseDir = getPaprBaseDir();
  const resolvedTarget = path.resolve(input.targetPaprHome);
  if (resolvedTarget === path.resolve(baseDir)) {
    return { archivedGitDir: null, archivedSyncState: false };
  }

  const staleGit = path.join(baseDir, ".git");
  const workspaceGit = path.join(input.targetPaprHome, ".git");
  let archivedGitDir: string | null = null;

  try {
    await fsPromises.access(staleGit);
    await fsPromises.access(workspaceGit);
    const backupName = `.git.stale-flat-root-${Date.now()}`;
    await fsPromises.rename(staleGit, path.join(baseDir, backupName));
    archivedGitDir = backupName;
  } catch {
    // no stale root git, or workspace repo not initialized yet
  }

  let archivedSyncState = false;
  const staleSyncState = path.join(baseDir, ".cloud-sync-state.json");
  const workspaceSyncState = path.join(input.targetPaprHome, ".cloud-sync-state.json");
  try {
    await fsPromises.access(staleSyncState);
    await fsPromises.access(workspaceSyncState);
    await fsPromises.rename(
      staleSyncState,
      path.join(baseDir, `.cloud-sync-state.stale-flat-root-${Date.now()}.json`),
    );
    archivedSyncState = true;
  } catch {
    // nothing to archive
  }

  return { archivedGitDir, archivedSyncState };
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
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.rename(sourcePath, targetPath);
    return true;
  }

  if (input.dirName === "apps") {
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    return mergeAppsDirFromSource(sourcePath, targetPath);
  }

  if (await targetAcceptsLegacyMerge(targetPath, input.dirName)) {
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    return mergeLegacyDirIntoTarget(sourcePath, targetPath);
  }

  return false;
}

/**
 * Merge per-app source trees when the active workspace has registry scaffolds
 * (metadata.json) but no index.html. Sources: prior migration target, flat ~/Papr/apps.
 */
export async function repairIncompleteAppSources(input: {
  targetPaprHome: string;
}): Promise<{ repairedAppIds: string[]; sourceRoots: string[] }> {
  const targetAppsDir = path.join(input.targetPaprHome, "apps");
  if (!pathHasContents(targetAppsDir)) {
    return { repairedAppIds: [], sourceRoots: [] };
  }

  const sourceRoots: string[] = [];
  const record = readLegacyMigrationRecord();
  if (record?.targetPaprHome) {
    const recordApps = path.join(record.targetPaprHome, "apps");
    if (
      path.normalize(recordApps) !== path.normalize(targetAppsDir) &&
      pathHasContents(recordApps)
    ) {
      sourceRoots.push(recordApps);
    }
  }

  const legacyApps = path.join(getPaprBaseDir(), "apps");
  if (
    path.normalize(legacyApps) !== path.normalize(targetAppsDir) &&
    pathHasContents(legacyApps)
  ) {
    sourceRoots.push(legacyApps);
  }

  for (const workspacePath of await listOrgNamespaceWorkspacePaths()) {
    const otherApps = path.join(workspacePath, "apps");
    if (
      path.normalize(otherApps) !== path.normalize(targetAppsDir) &&
      pathHasContents(otherApps) &&
      !sourceRoots.some((root) => path.normalize(root) === path.normalize(otherApps))
    ) {
      sourceRoots.push(otherApps);
    }
  }

  if (sourceRoots.length === 0) {
    return { repairedAppIds: [], sourceRoots: [] };
  }

  const repairedAppIds: string[] = [];
  for (const entry of listVisibleEntries(targetAppsDir)) {
    const targetAppDir = path.join(targetAppsDir, entry);
    let targetStat;
    try {
      targetStat = await fsPromises.stat(targetAppDir);
    } catch {
      continue;
    }
    if (!targetStat.isDirectory()) {
      continue;
    }
    if (await appDirHasIndexHtml(targetAppDir)) {
      continue;
    }

    for (const sourceRoot of sourceRoots) {
      const sourceAppDir = path.join(sourceRoot, entry);
      try {
        const sourceStat = await fsPromises.stat(sourceAppDir);
        if (!sourceStat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      if (!(await appDirHasIndexHtml(sourceAppDir))) {
        continue;
      }
      await mergeLegacyDirIntoTarget(sourceAppDir, targetAppDir);
      if (await appDirHasIndexHtml(targetAppDir)) {
        repairedAppIds.push(entry);
      }
      break;
    }
  }

  return { repairedAppIds, sourceRoots };
}

export interface LegacyWorkspaceMigrationRunResult {
  flatLayout: LegacyWorkspaceMigrationRecord | null;
  relocated: { relocatedPaths: string[]; relocatedUserDataFiles: string[] } | null;
  namespaceRelocated: { relocatedPaths: string[]; sourceHomes: string[] } | null;
  repairedAppIds: string[];
  repairedAppSourceRoots: string[];
  userDataFiles: string[] | null;
}

export function emptyLegacyWorkspaceMigrationResult(): LegacyWorkspaceMigrationRunResult {
  return {
    flatLayout: null,
    relocated: null,
    namespaceRelocated: null,
    repairedAppIds: [],
    repairedAppSourceRoots: [],
    userDataFiles: null,
  };
}

/**
 * When the user switches org/namespace, move data that a prior consent migration
 * landed in the wrong workspace (per .legacy-workspace-migration.json).
 * Does not move flat ~/Papr root content — that requires user consent.
 */
export async function runRelocateMisplacedLegacyMigrationOnly(input: {
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
  targetUserDataPath: string;
}): Promise<LegacyWorkspaceMigrationRunResult> {
  const relocated = await relocateMisplacedLegacyMigration(input);
  return {
    ...emptyLegacyWorkspaceMigrationResult(),
    relocated,
  };
}

/**
 * Legacy self-heal pipeline (flat move, namespace merge, incomplete app repair).
 * Disabled in production — use runUserConsentFlatPaprMigration() from the UI instead.
 * Pass allowAutomatedSelfHeal: true only in tests.
 */
export async function runLegacyWorkspaceDataMigration(input: {
  organizationId: string;
  namespaceId: string;
  targetPaprHome: string;
  targetUserDataPath: string;
  /** When true, skip flat ~/Papr moves (consent migration runs separately). */
  skipFlatPaprMigration?: boolean;
  /** Must be true to run destructive self-heal (tests only; never set in app startup). */
  allowAutomatedSelfHeal?: boolean;
}): Promise<LegacyWorkspaceMigrationRunResult> {
  if (input.allowAutomatedSelfHeal !== true) {
    return emptyLegacyWorkspaceMigrationResult();
  }

  const unmigratedFlat = detectUnmigratedFlatPaprContent();
  const skipFlat =
    input.skipFlatPaprMigration === true || unmigratedFlat;

  let flatLayout: LegacyWorkspaceMigrationRecord | null = null;
  if (!skipFlat) {
    flatLayout = await migrateLegacyFlatPaprLayout({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      targetPaprHome: input.targetPaprHome,
    });
  }

  const relocated = await relocateMisplacedLegacyMigration({
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    targetPaprHome: input.targetPaprHome,
    targetUserDataPath: input.targetUserDataPath,
  });

  let repair = { repairedAppIds: [] as string[], sourceRoots: [] as string[] };
  if (!unmigratedFlat) {
    repair = await repairIncompleteAppSources({
      targetPaprHome: input.targetPaprHome,
    });
  }

  let userDataFiles: string[] | null = null;
  if (!unmigratedFlat) {
    userDataFiles = await migrateLegacyUserDataRuntime({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      targetPaprHome: input.targetPaprHome,
      targetUserDataPath: input.targetUserDataPath,
    });
  }

  let namespaceRelocated: { relocatedPaths: string[]; sourceHomes: string[] } | null =
    null;
  if (!unmigratedFlat) {
    namespaceRelocated = await relocateMisplacedNamespaceContent({
      targetPaprHome: input.targetPaprHome,
    });
  }

  return {
    flatLayout,
    relocated,
    namespaceRelocated,
    repairedAppIds: repair.repairedAppIds,
    repairedAppSourceRoots: repair.sourceRoots,
    userDataFiles,
  };
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
    const legacyPath = path.join(baseDir, dirName);
    const legacyStillHasContent = pathHasContents(legacyPath);
    // Resume when a prior run recorded the dir as moved but files remain at ~/Papr/.
    if (movedSet.has(dirName) && !legacyStillHasContent) {
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
  const pointer = readActiveWorkspacePointer();
  const isCloudAgent = process.env.GATEWAY_MODE === "cloud_agent";

  if (!isCloudAgent && pointer?.userDataPath) {
    const pointerPath = path.resolve(pointer.userDataPath);
    if (fromEnv && path.resolve(fromEnv) !== pointerPath) {
      console.warn(
        `[PaprWorkspace] PAPR_USER_DATA (${path.resolve(fromEnv)}) differs from active workspace (${pointerPath}); using pointer`,
      );
    }
    return pointerPath;
  }

  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  if (pointer?.userDataPath) {
    return pointer.userDataPath;
  }
  return getPaprworkBaseDir();
}
