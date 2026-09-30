#!/usr/bin/env node
/**
 * One-time workspace repair:
 * - Papr production (Y8D4H7Yp3Z / 85ZIB7mD1V): all apps/jobs/dbs EXCEPT MyAdvice-only items
 * - MyAdvice (crwNcCnClI / VIA2C5VDxj): only MyAdvice Meetings + Audit Workbench (+ linked jobs)
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { existsSync } from "fs";

const MYADVICE_KEEP_APPS = new Set([
  "6564707e-3ea1-43e5-8893-2e999f29a116", // MyAdvice Meetings
  "c2ab1b37-cf43-41c7-8999-3e9677f1f58b", // Audit Workbench
]);

const MYADVICE_KEEP_JOBS = new Set([
  "a5b67ed7-2372-42af-bc39-59570f1455b9", // Fetch MyAdvice Attention Meetings
  "f4216c10-32d5-4ba3-80c2-8a0ad6bc1e36",
  "cae031f6-0290-43b9-9cf9-cfad47a1a281",
  "301a89b0-1ff2-4bf4-8944-bd042a985079",
  "0d1ec4c0-c56c-4612-b4da-d077a8d19f44",
  "1c96deaf-be17-4c90-b253-3cc008956ab6",
  "44f6f774-7101-4d06-8144-01f0bbab61e4",
  "56a75c71-a6da-4472-90ab-77149d93889f",
  "53ce8ebc-54c7-44dc-8808-8d173b578dcb",
  "4d3d7f50-8fc3-43dd-81cb-33de33096b0a",
  "7284c577-5996-45c8-97e4-b86fb89c2989",
  "3dc70120-4e26-47ec-89eb-92146dd592fe",
]);

const PROD_ORG = "Y8D4H7Yp3Z";
const PROD_NS = "85ZIB7mD1V";
const MYADV_ORG = "crwNcCnClI";
const MYADV_NS = "VIA2C5VDxj";

const PAPR_BASE = path.join(process.env.HOME ?? "", "Papr");
const PROD_HOME = path.join(PAPR_BASE, "orgs", PROD_ORG, "namespaces", PROD_NS);
const MYADV_HOME = path.join(PAPR_BASE, "orgs", MYADV_ORG, "namespaces", MYADV_NS);
const OLD_HOME = path.join(PAPR_BASE, "orgs", PROD_ORG, "namespaces", "onnNQFe3DN");

const dryRun = process.argv.includes("--dry-run");
const ts = new Date().toISOString().replace(/[:.]/g, "-");

async function countFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

async function dbSize(jobHome, jobId) {
  try {
    const s = await stat(path.join(jobHome, "Jobs", jobId, "data", "data.db"));
    return s.size;
  } catch {
    return 0;
  }
}

async function copyDirRecursive(src, dest) {
  if (dryRun) {
    console.log(`[dry-run] cp -a ${src} -> ${dest}`);
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  if (dryRun) {
    console.log(`[dry-run] write ${filePath} (${Array.isArray(data) ? data.length : Object.keys(data).length} entries)`);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-repair-${ts}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

function withProdScope(app) {
  return {
    ...app,
    organizationId: PROD_ORG,
    namespaceId: PROD_NS,
    updatedAt: new Date().toISOString(),
  };
}

function withMyAdvScope(app) {
  return {
    ...app,
    organizationId: MYADV_ORG,
    namespaceId: MYADV_NS,
    updatedAt: new Date().toISOString(),
  };
}

async function pickBestAppSource(appId) {
  const candidates = [
    { home: MYADV_HOME, label: "myadv" },
    { home: PROD_HOME, label: "prod" },
    { home: OLD_HOME, label: "old" },
  ];
  let best = null;
  for (const c of candidates) {
    const dir = path.join(c.home, "apps", appId);
    if (!existsSync(dir)) continue;
    const files = await countFiles(dir);
    if (!best || files > best.files) {
      best = { ...c, dir, files };
    }
  }
  return best;
}

async function syncJobFromSources(jobId, targetHome, excludeHomes = []) {
  const sources = [OLD_HOME, PROD_HOME, MYADV_HOME].filter(
    (h) => !excludeHomes.includes(h),
  );
  let best = null;
  for (const home of sources) {
    const jobDir = path.join(home, "Jobs", jobId);
    if (!existsSync(jobDir)) continue;
    const size = await dbSize(home, jobId);
    const files = await countFiles(jobDir);
    const score = size * 1000 + files;
    if (!best || score > best.score) {
      best = { home, jobDir, size, files, score };
    }
  }
  if (!best) return false;

  const targetDir = path.join(targetHome, "Jobs", jobId);
  const targetSize = await dbSize(targetHome, jobId);
  const targetExists = existsSync(targetDir);

  if (targetExists && targetSize >= best.size && targetSize > 0) {
    return false;
  }

  console.log(
    `  job ${jobId}: copy from ${path.basename(path.dirname(path.dirname(best.home)))}/…/${path.basename(best.home)} (${best.files} files, db=${best.size}b) -> ${path.basename(targetHome)}`,
  );
  await copyDirRecursive(best.jobDir, targetDir);
  return true;
}

async function fixDataSourcePaths(appDir, home) {
  const dsPath = path.join(appDir, "data-sources.json");
  if (!existsSync(dsPath)) return;

  const raw = await readFile(dsPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const sources = Array.isArray(parsed) ? parsed : parsed.sources ?? [];
  let changed = false;
  const homePrefix = `${home}/`;

  for (const source of sources) {
    if (typeof source.dbPath === "string" && source.dbPath.includes("/Papr/")) {
      if (source.jobId) {
        const canonical = path.join(home, "Jobs", source.jobId, "data", "data.db");
        if (source.dbPath !== canonical && existsSync(canonical)) {
          source.dbPath = canonical;
          changed = true;
        } else if (source.dbPath.startsWith(homePrefix)) {
          // already in this home
        } else {
          source.dbPath = "";
          changed = true;
        }
      } else if (source.dbPath.includes("/data/databases/")) {
        const slug = source.dbPath.split("/data/databases/")[1]?.split("/")[0];
        if (slug) {
          const canonical = path.join(home, "data", "databases", slug, "data.db");
          if (existsSync(canonical)) {
            source.dbPath = canonical;
            changed = true;
          }
        }
      }
    }
  }

  if (!changed) return;

  const out = Array.isArray(parsed) ? sources : { ...parsed, sources };
  if (dryRun) {
    console.log(`[dry-run] fix data-sources ${dsPath}`);
    return;
  }
  await writeFile(dsPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
}

async function main() {
  console.log(`Repair workspace split${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`  PROD: ${PROD_HOME}`);
  console.log(`  MYADV: ${MYADV_HOME}`);
  console.log(`  OLD jobs source: ${OLD_HOME}`);

  // Backup registries
  for (const home of [PROD_HOME, MYADV_HOME, OLD_HOME]) {
    for (const file of ["apps.json", "jobs.json", "job-graph.json"]) {
      const src = path.join(home, "data", file);
      if (!existsSync(src)) continue;
      const backup = `${src}.backup-repair-${ts}`;
      if (!dryRun) {
        await cp(src, backup);
      }
      console.log(`Backed up ${file} -> ${path.basename(backup)}`);
    }
  }

  // --- Jobs: MyAdvice namespace gets keep jobs ---
  console.log("\n=== Sync MyAdvice jobs ===");
  let myadvJobsCopied = 0;
  for (const jobId of MYADVICE_KEEP_JOBS) {
    if (await syncJobFromSources(jobId, MYADV_HOME)) {
      myadvJobsCopied += 1;
    }
  }

  // --- Jobs: Production gets everything else from OLD (+ fill gaps from prod) ---
  console.log("\n=== Sync production jobs from old namespace ===");
  let prodJobsCopied = 0;
  const oldJobIds = existsSync(path.join(OLD_HOME, "Jobs"))
    ? await readdir(path.join(OLD_HOME, "Jobs"))
    : [];
  for (const jobId of oldJobIds) {
    if (MYADVICE_KEEP_JOBS.has(jobId)) continue;
    if (await syncJobFromSources(jobId, PROD_HOME)) {
      prodJobsCopied += 1;
    }
  }

  // --- Apps: copy best source to production (except MyAdvice keep) ---
  console.log("\n=== Sync production apps ===");
  const myadvApps = await readJson(path.join(MYADV_HOME, "data", "apps.json"), []);
  const prodApps = await readJson(path.join(PROD_HOME, "data", "apps.json"), []);
  const prodById = new Map(prodApps.map((a) => [a.id, a]));
  const myadvById = new Map(myadvApps.map((a) => [a.id, a]));

  const allAppIds = new Set([
    ...myadvApps.map((a) => a.id),
    ...prodApps.map((a) => a.id),
  ]);

  let prodAppsCopied = 0;
  for (const appId of allAppIds) {
    if (MYADVICE_KEEP_APPS.has(appId)) continue;

    const best = await pickBestAppSource(appId);
    if (!best) continue;

    const prodDir = path.join(PROD_HOME, "apps", appId);
    const prodFiles = existsSync(prodDir) ? await countFiles(prodDir) : 0;

    if (best.files > prodFiles || !existsSync(prodDir)) {
      console.log(
        `  app ${appId}: copy from ${best.label} (${best.files} files) -> prod`,
      );
      await copyDirRecursive(best.dir, prodDir);
      prodAppsCopied += 1;
    }

    const entry = { ...(prodById.get(appId) ?? myadvById.get(appId)) };
    if (!entry.id) continue;
    prodById.set(appId, withProdScope(entry));
  }

  // Remove MyAdvice-only apps from production registry + disk
  for (const appId of MYADVICE_KEEP_APPS) {
    prodById.delete(appId);
    const prodAppDir = path.join(PROD_HOME, "apps", appId);
    if (existsSync(prodAppDir)) {
      console.log(`  remove MyAdvice-only app from prod disk: ${appId}`);
      if (!dryRun) await rm(prodAppDir, { recursive: true, force: true });
    }
  }

  // --- MyAdvice apps: only keep two, best source for audit ---
  console.log("\n=== Sync MyAdvice-only apps ===");
  for (const appId of MYADVICE_KEEP_APPS) {
    const best = await pickBestAppSource(appId);
    if (best) {
      const target = path.join(MYADV_HOME, "apps", appId);
      const current = existsSync(target) ? await countFiles(target) : 0;
      if (best.files > current) {
        console.log(`  app ${appId}: refresh from ${best.label} (${best.files} files)`);
        await copyDirRecursive(best.dir, target);
      }
    }
  }

  const myadvFinalApps = [];
  for (const appId of MYADVICE_KEEP_APPS) {
    const entry = myadvById.get(appId) ?? prodApps.find((a) => a.id === appId);
    if (entry) {
      myadvFinalApps.push(withMyAdvScope(entry));
    }
  }

  // Remove non-keep app folders from MyAdvice disk
  const myadvAppDirs = existsSync(path.join(MYADV_HOME, "apps"))
    ? await readdir(path.join(MYADV_HOME, "apps"))
    : [];
  let myadvAppsRemoved = 0;
  for (const appId of myadvAppDirs) {
    if (MYADVICE_KEEP_APPS.has(appId)) continue;
    const dir = path.join(MYADV_HOME, "apps", appId);
    console.log(`  remove non-MyAdvice app from myadv disk: ${appId}`);
    if (!dryRun) await rm(dir, { recursive: true, force: true });
    myadvAppsRemoved += 1;
  }

  // --- Merge jobs.json ---
  console.log("\n=== Merge jobs.json ===");
  const oldJobs = await readJson(path.join(OLD_HOME, "data", "jobs.json"), []);
  const prodJobs = await readJson(path.join(PROD_HOME, "data", "jobs.json"), []);
  const myadvJobs = await readJson(path.join(MYADV_HOME, "data", "jobs.json"), []);

  const prodJobsById = new Map(prodJobs.map((j) => [j.id, j]));
  const myadvJobsById = new Map();

  for (const job of [...oldJobs, ...prodJobs, ...myadvJobs]) {
    if (MYADVICE_KEEP_JOBS.has(job.id)) {
      myadvJobsById.set(job.id, job);
    } else if (!prodJobsById.has(job.id) || oldJobs.some((o) => o.id === job.id)) {
      prodJobsById.set(job.id, job);
    }
  }

  for (const jobId of MYADVICE_KEEP_JOBS) {
    prodJobsById.delete(jobId);
    const prodJobDir = path.join(PROD_HOME, "Jobs", jobId);
    if (existsSync(prodJobDir)) {
      console.log(`  remove MyAdvice job from prod disk: ${jobId}`);
      if (!dryRun) await rm(prodJobDir, { recursive: true, force: true });
    }
  }

  const myadvJobDirs = existsSync(path.join(MYADV_HOME, "Jobs"))
    ? await readdir(path.join(MYADV_HOME, "Jobs"))
    : [];
  for (const jobId of myadvJobDirs) {
    if (MYADVICE_KEEP_JOBS.has(jobId)) continue;
    const dir = path.join(MYADV_HOME, "Jobs", jobId);
    console.log(`  remove non-MyAdvice job from myadv disk: ${jobId}`);
    if (!dryRun) await rm(dir, { recursive: true, force: true });
  }

  // --- Merge job-graph (prod from old, strip myadvice apps from prod) ---
  const oldGraph = await readJson(path.join(OLD_HOME, "data", "job-graph.json"), {
    appLinks: {},
  });
  const prodGraph = await readJson(path.join(PROD_HOME, "data", "job-graph.json"), {
    appLinks: {},
  });
  const mergedGraph = {
    ...oldGraph,
    ...prodGraph,
    appLinks: { ...oldGraph.appLinks, ...prodGraph.appLinks },
  };
  for (const appId of MYADVICE_KEEP_APPS) {
    delete mergedGraph.appLinks[appId];
  }
  for (const [appId, link] of Object.entries(mergedGraph.appLinks)) {
    if (link && typeof link === "object" && "jobIds" in link) {
      link.jobIds = (link.jobIds ?? []).filter((id) => !MYADVICE_KEEP_JOBS.has(id));
    }
  }

  const myadvGraph = {
    appLinks: {},
  };
  for (const appId of MYADVICE_KEEP_APPS) {
    const fromOld = oldGraph.appLinks?.[appId];
    if (fromOld) myadvGraph.appLinks[appId] = fromOld;
  }

  // --- Fix data-sources paths ---
  console.log("\n=== Fix data-sources paths ===");
  for (const appId of prodById.keys()) {
    await fixDataSourcePaths(path.join(PROD_HOME, "apps", appId), PROD_HOME);
  }
  for (const appId of MYADVICE_KEEP_APPS) {
    await fixDataSourcePaths(path.join(MYADV_HOME, "apps", appId), MYADV_HOME);
  }

  // --- Write registries ---
  await writeJsonAtomic(
    path.join(PROD_HOME, "data", "apps.json"),
    [...prodById.values()].sort((a, b) => a.title.localeCompare(b.title)),
  );
  await writeJsonAtomic(path.join(MYADV_HOME, "data", "apps.json"), myadvFinalApps);
  await writeJsonAtomic(
    path.join(PROD_HOME, "data", "jobs.json"),
    [...prodJobsById.values()],
  );
  await writeJsonAtomic(
    path.join(MYADV_HOME, "data", "jobs.json"),
    [...myadvJobsById.values()],
  );
  await writeJsonAtomic(path.join(PROD_HOME, "data", "job-graph.json"), mergedGraph);
  await writeJsonAtomic(path.join(MYADV_HOME, "data", "job-graph.json"), myadvGraph);

  console.log("\n=== Summary ===");
  console.log(`Production apps in registry: ${prodById.size}`);
  console.log(`MyAdvice apps in registry: ${myadvFinalApps.length}`);
  console.log(`Production jobs in registry: ${prodJobsById.size}`);
  console.log(`MyAdvice jobs in registry: ${myadvJobsById.size}`);
  console.log(`Jobs copied -> prod: ${prodJobsCopied}, myadv: ${myadvJobsCopied}`);
  console.log(`Apps copied -> prod: ${prodAppsCopied}`);
  console.log(`Apps removed from myadv disk: ${myadvAppsRemoved}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
