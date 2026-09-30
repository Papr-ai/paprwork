#!/usr/bin/env node
/**
 * Clean up Sync V3 genesis noise:
 * - Tombstone orphaned job DB registry entries (missing data.db / job folder)
 * - Recover corrupt SQLite job databases via sqlite3 .recover
 * - Repair databases.json localPath to active workspace
 * - Scrub stale data-sources.json links
 *
 * Usage:
 *   node --import tsx scripts/cleanup-sync-v3-db-hygiene.mjs
 *   PAPR_HOME=/path/to/namespace node --import tsx scripts/cleanup-sync-v3-db-hygiene.mjs --dry-run
 */

import { execFileSync, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORPHAN_JOB_IDS = [
  "ec49d9eb-72a0-424e-9955-c4bf07f89bed",
  "33f9e34c-1dad-4997-a893-a6e8caafeb84",
  "abd8058e-7d56-4e1f-9f92-368462832c91",
  "3a73c753-4f4c-41dd-96ef-929ba51d5a1d",
];

const CORRUPT_JOB_IDS = [
  "3dc70120-4e26-47ec-89eb-92146dd592fe",
  "4c2be1f4-09c8-450a-a992-6279beacae71",
  "2db5c690-07e2-4224-b9bd-9f24f9dc3978",
  "2b15ccb4-8d8f-48ad-99a0-964905e382b8",
  "c80cf72b-6c65-4ade-b0af-e601e4e80c5a",
  "c1485663-9f54-4db9-844e-bce519246cd1",
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

function resolvePaprRoot() {
  if (process.env.PAPR_HOME?.trim()) {
    return path.resolve(process.env.PAPR_HOME.trim());
  }
  const home = process.env.HOME ?? "";
  return path.join(home, "Papr", "orgs", "Y8D4H7Yp3Z", "namespaces", "85ZIB7mD1V");
}

function jobDbPath(paprRoot, jobId) {
  return path.join(paprRoot, "Jobs", jobId, "data", "data.db");
}

function jobTursoShortName(jobId) {
  return `j-${jobId.replace(/-/g, "").slice(0, 8)}`;
}

function replicaIdForJob(jobId) {
  return jobTursoShortName(jobId);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function backupFile(filePath, stamp) {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const backupPath = `${filePath}.backup-${stamp}`;
  if (dryRun) {
    return null;
  }
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  if (dryRun) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runSqlite(argsList) {
  return execFileSync("sqlite3", argsList, { encoding: "utf8" }).trim();
}

function integrityOk(dbPath) {
  try {
    const result = runSqlite([dbPath, "PRAGMA integrity_check;"]);
    return result.split("\n").every((line) => line.trim() === "ok");
  } catch {
    return false;
  }
}

async function recoverDatabase(dbPath) {
  const recoveredPath = `${dbPath}.recovered-${Date.now()}`;
  execSync(`sqlite3 ${shellQuote(dbPath)} ".recover" | sqlite3 ${shellQuote(recoveredPath)}`, {
    stdio: "pipe",
  });
  if (!integrityOk(recoveredPath)) {
    await fs.unlink(recoveredPath).catch(() => {});
    throw new Error("recovered database failed integrity_check");
  }
  // `.recover` can leave an artifact table that breaks schema evaluation.
  execSync(
    `sqlite3 ${shellQuote(recoveredPath)} "DROP TABLE IF EXISTS lost_and_found;"`,
    { stdio: "pipe" },
  );
  return recoveredPath;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function scrubDataSources(appsDir, jobIds) {
  const jobIdSet = new Set(jobIds);
  let changedFiles = 0;
  let removedSources = 0;

  if (!(await pathExists(appsDir))) {
    return { changedFiles, removedSources };
  }

  const appEntries = await fs.readdir(appsDir, { withFileTypes: true });
  for (const entry of appEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const configPath = path.join(appsDir, entry.name, "data-sources.json");
    let raw;
    try {
      raw = await fs.readFile(configPath, "utf8");
    } catch {
      continue;
    }

    const config = JSON.parse(raw);
    if (!Array.isArray(config.sources)) {
      continue;
    }

    const before = config.sources.length;
    config.sources = config.sources.filter((source) => {
      if (source.jobId && jobIdSet.has(source.jobId)) {
        return false;
      }
      return true;
    });
    const after = config.sources.length;
    if (after === before) {
      continue;
    }

    removedSources += before - after;
    changedFiles += 1;
    await writeJson(configPath, config);
    console.log(
      `[cleanup] scrubbed ${before - after} source(s) from apps/${entry.name}/data-sources.json`,
    );
  }

  return { changedFiles, removedSources };
}

async function cleanupJobsJson(dataDir, jobIds) {
  const jobsPath = path.join(dataDir, "jobs.json");
  const jobs = await readJson(jobsPath);
  if (!Array.isArray(jobs)) {
    throw new Error("jobs.json is not an array");
  }
  const jobIdSet = new Set(jobIds);
  const before = jobs.length;
  const filtered = jobs
    .filter((job) => !jobIdSet.has(job.id))
    .map((job) => {
      if (!Array.isArray(job.dependsOn)) {
        return job;
      }
      const dependsOn = job.dependsOn.filter((dep) => !jobIdSet.has(dep));
      if (dependsOn.length === job.dependsOn.length) {
        return job;
      }
      return { ...job, dependsOn };
    });
  const beforeJson = JSON.stringify(jobs);
  const afterJson = JSON.stringify(filtered);
  if (beforeJson !== afterJson) {
    await writeJson(jobsPath, filtered);
    console.log(`[cleanup] updated jobs.json (removed ${before - filtered.length} job record(s))`);
  }
}

async function cleanupJobGraph(dataDir, jobIds) {
  const graphPath = path.join(dataDir, "job-graph.json");
  if (!(await pathExists(graphPath))) {
    return;
  }
  const graph = await readJson(graphPath);
  const jobIdSet = new Set(jobIds);

  if (graph.folders && typeof graph.folders === "object") {
    for (const [folderName, jobList] of Object.entries(graph.folders)) {
      if (!Array.isArray(jobList)) {
        continue;
      }
      graph.folders[folderName] = jobList.filter((jobId) => !jobIdSet.has(jobId));
    }
  }

  if (graph.appLinks && typeof graph.appLinks === "object") {
    for (const link of Object.values(graph.appLinks)) {
      if (!Array.isArray(link.jobIds)) {
        continue;
      }
      link.jobIds = link.jobIds.filter((jobId) => !jobIdSet.has(jobId));
    }
  }

  graph.updatedAt = new Date().toISOString();
  await writeJson(graphPath, graph);
  console.log("[cleanup] updated job-graph.json");
}

async function tombstoneRegistryForJobs(dataDir, jobIds) {
  const registryPath = path.join(dataDir, "databases.json");
  const registry = await readJson(registryPath);
  const jobIdSet = new Set(jobIds);
  let tombstoned = 0;

  for (const record of Object.values(registry.databases ?? {})) {
    if (record.ownerJobId && jobIdSet.has(record.ownerJobId) && record.status === "active") {
      record.status = "tombstone";
      record.updatedAt = new Date().toISOString();
      tombstoned += 1;
      console.log(`[cleanup] tombstoned registry ${record.dbId} (${record.ownerJobId})`);
    }
  }

  if (tombstoned > 0) {
    await writeJson(registryPath, registry);
  }
  return tombstoned;
}

async function repairRegistryPaths(dataDir, paprRoot) {
  const registryPath = path.join(dataDir, "databases.json");
  const registry = await readJson(registryPath);
  const canonicalByShortName = new Map();
  let repaired = 0;
  let tombstonedDupes = 0;

  for (const record of Object.values(registry.databases ?? {})) {
    if (record.status !== "active" || !record.ownerJobId) {
      continue;
    }
    const canonical = jobDbPath(paprRoot, record.ownerJobId);
    if (!(await pathExists(canonical))) {
      continue;
    }
    const shortName = record.tursoShortName;
    const existing = canonicalByShortName.get(shortName);
    if (existing && existing !== canonical) {
      if (record.localPath === canonical) {
        continue;
      }
      record.status = "tombstone";
      record.updatedAt = new Date().toISOString();
      tombstonedDupes += 1;
      console.log(`[cleanup] tombstoned duplicate registry ${record.dbId} (${shortName})`);
      continue;
    }
    canonicalByShortName.set(shortName, canonical);
    if (path.normalize(record.localPath) !== path.normalize(canonical)) {
      console.log(
        `[cleanup] repaired localPath for ${record.dbId}: ${record.localPath} -> ${canonical}`,
      );
      record.localPath = canonical;
      record.updatedAt = new Date().toISOString();
      repaired += 1;
    }
  }

  if (repaired > 0 || tombstonedDupes > 0) {
    await writeJson(registryPath, registry);
  }
  return { repaired, tombstonedDupes };
}

async function recoverCorruptJobs(paprRoot) {
  const results = [];
  for (const jobId of CORRUPT_JOB_IDS) {
    const dbPath = jobDbPath(paprRoot, jobId);
    if (!(await pathExists(dbPath))) {
      results.push({ jobId, status: "missing" });
      continue;
    }

    if (integrityOk(dbPath)) {
      results.push({ jobId, status: "already_ok" });
      continue;
    }

    try {
      if (!dryRun) {
        const backupPath = `${dbPath}.corrupt-backup-${Date.now()}`;
        await fs.copyFile(dbPath, backupPath);
        const recoveredPath = await recoverDatabase(dbPath);
        await fs.rename(recoveredPath, dbPath);
        for (const suffix of ["-shm", "-wal"]) {
          await fs.unlink(`${dbPath}${suffix}`).catch(() => {});
        }
      }
      results.push({ jobId, status: dryRun ? "would_recover" : "recovered" });
      console.log(`[cleanup] recovered ${jobId}`);
    } catch (error) {
      results.push({ jobId, status: "failed", error: error.message });
      console.warn(`[cleanup] recover failed for ${jobId}: ${error.message}`);
    }
  }
  return results;
}

async function clearCutoverForReplicas(dataDir, replicaIds) {
  const cutoverPath = path.join(dataDir, "workspace-log-cutover.json");
  if (!(await pathExists(cutoverPath))) {
    return 0;
  }
  const cutover = await readJson(cutoverPath);
  let removed = 0;
  for (const replicaId of replicaIds) {
    if (cutover.replicas?.[replicaId]) {
      delete cutover.replicas[replicaId];
      removed += 1;
    }
  }
  if (removed > 0) {
    cutover.updatedAt = new Date().toISOString();
    await writeJson(cutoverPath, cutover);
    console.log(`[cleanup] cleared ${removed} workspace-log cutover record(s)`);
  }
  return removed;
}

async function removeOrphanJobFolders(paprRoot, jobIds) {
  for (const jobId of jobIds) {
    const jobDir = path.join(paprRoot, "Jobs", jobId);
    if (!(await pathExists(jobDir))) {
      continue;
    }
    if (!dryRun) {
      await fs.rm(jobDir, { recursive: true, force: true });
    }
    console.log(`[cleanup] removed orphan job folder Jobs/${jobId}`);
  }
}

async function main() {
  const paprRoot = resolvePaprRoot();
  const dataDir = path.join(paprRoot, "data");
  const appsDir = path.join(paprRoot, "apps");
  const stamp = Date.now();

  console.log(`[cleanup] paprRoot=${paprRoot}`);
  console.log(`[cleanup] dryRun=${dryRun}`);

  for (const file of ["databases.json", "jobs.json", "job-graph.json", "workspace-log-cutover.json"]) {
    const p = path.join(dataDir, file);
    const backup = await backupFile(p, stamp);
    if (backup) {
      console.log(`[cleanup] backup ${backup}`);
    }
  }

  const recoverResults = await recoverCorruptJobs(paprRoot);
  const repair = await repairRegistryPaths(dataDir, paprRoot);

  await tombstoneRegistryForJobs(dataDir, ORPHAN_JOB_IDS);
  await cleanupJobsJson(dataDir, ORPHAN_JOB_IDS);
  await cleanupJobGraph(dataDir, ORPHAN_JOB_IDS);
  const scrub = await scrubDataSources(appsDir, ORPHAN_JOB_IDS);
  await removeOrphanJobFolders(paprRoot, ORPHAN_JOB_IDS);

  const replicaIdsToClear = [
    ...ORPHAN_JOB_IDS.map(replicaIdForJob),
    ...CORRUPT_JOB_IDS.map(replicaIdForJob),
  ];
  await clearCutoverForReplicas(dataDir, replicaIdsToClear);

  console.log("\n[cleanup] summary");
  console.log(JSON.stringify({ recoverResults, repair, scrub }, null, 2));

  if (!dryRun) {
    const electronBin = path.join(
      __dirname,
      "..",
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    );
    execSync(
      `${shellQuote(electronBin)} --import tsx ${shellQuote(path.join(__dirname, "run-workspace-log-genesis-cutover.mjs"))}`,
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "inherit",
      },
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
